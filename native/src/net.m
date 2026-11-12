// net.m — peer-to-peer connections on Network.framework, run off the main thread.
//
// Network.framework calls back on a dispatch queue, and JavaScript may only run
// on the main thread, inside BunKit's pump or Bun's own event loop. So nothing
// here calls into JavaScript with data. Every listener, browser and connection
// lives on one private serial queue ("bunkit.net"), where all of its handlers
// run and all of its state is touched; what JavaScript needs to hear about is
// appended to one event list under a lock, and JavaScript takes the events in
// batches with br_net_poll.
//
// JavaScript learns there is something to take at most once between two polls
// (the list going from empty to not), two ways at once. BunKit's main loop is
// signalled (br_main_signal), and its turn — which runs inside the pump and inside
// any nested loop AppKit is running, a menu or a live resize — takes the events.
// And a `threadsafe` bun:ffi callback queues a task on Bun's event loop, for a
// process that is not pumping or net used from a thread. Whichever runs first
// drains; the drain itself is ordinary JavaScript on the main thread. A small
// message's round trip is 0.12 ms median, 0.15 ms inside BunKit's run loop.
//
// Why a private queue and not the main queue. Measured on an M2 Pro (macOS
// 26.6) over loopback: on the main queue the handlers run only while the pump
// is in AppKit, so in a process that does not pump nothing moves at all, and
// with the main thread busy 8 ms in every 10 (a heavy show clock) 1 MiB messages
// moved at 957 MiB/s against 1,544 here, 16 MiB ones at 1,368 against 3,527. Here
// the reading, the framing and the copy all happen while JavaScript is busy.
//
// Framing. A message is a 4-byte big-endian length and that many bytes, over
// TCP (or TLS over TCP). The receiver reads whatever has arrived, assembles each
// message in one malloc'd buffer, and hands that buffer to JavaScript, which
// wraps it in an ArrayBuffer without copying it again (br_net_release_bytes is
// its deallocator). A length over the connection's limit, or a peer that closes
// in the middle of a message, fails the connection with a message saying so.
//
// Flow control. Bytes received but not yet taken by br_net_poll are counted per
// connection; past BR_NET_HIGH_WATER the connection stops asking for more, so
// TCP's window closes and the sender's sends stop completing. A main thread held
// in a modal loop therefore costs memory up to the high-water mark per
// connection, never without bound.
//
// Ownership. Each object is reference counted: one reference for JavaScript
// (dropped by br_net_free), one for its own life on the queue (dropped when
// Network.framework reports it cancelled), and one for each receive, send or
// event still in flight. Every nw_* object made here is released here.

#import <Foundation/Foundation.h>
#import <Network/Network.h>
#import <Security/Security.h>
#include <dispatch/dispatch.h>
#include <errno.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include "bridge.h"

#define BR_NET_MAX_MESSAGE (16u * 1024u * 1024u)
// Received bytes not yet taken by JavaScript at which a connection stops reading,
// and the level it must fall back under before it reads again.
#define BR_NET_HIGH_WATER (64ll * 1024 * 1024)
#define BR_NET_LOW_WATER (16ll * 1024 * 1024)
// The most one receive asks Network.framework for.
#define BR_NET_RECEIVE_CHUNK (4u * 1024u * 1024u)
// What each delivered message counts against the high-water mark beyond its
// bytes, so a flood of empty messages is bounded too.
#define BR_NET_MESSAGE_OVERHEAD 64
// How long a close waits for queued sends to drain before cancelling anyway.
#define BR_NET_CLOSE_GRACE_NS (2ull * NSEC_PER_SEC)
// Room for an interface's BSD name.
#define IFNAMSIZ_COPY 32

// Event kinds. Stable numbers: src/net/index.ts mirrors them.
enum {
  BR_NET_EV_CONN_STATE = 1,     // a = BR_NET_STATE_*, ptr = error text or NULL
  BR_NET_EV_CONN_MESSAGE = 2,   // ptr = bytes (malloc'd) or NULL, len = length
  BR_NET_EV_CONN_SENT = 3,      // b = send sequence, a = 0 ok / 1 failed, ptr = error text
  BR_NET_EV_CONN_INFO = 4,      // ptr = JSON: path and TLS
  BR_NET_EV_LISTENER_STATE = 5, // a = BR_NET_STATE_*, b = port, ptr = error text
  BR_NET_EV_LISTENER_CONN = 6,  // b = the new connection's id, ptr = its handle (+1 for JS)
  BR_NET_EV_LISTENER_NAME = 7,  // ptr = the name Bonjour advertises it under
  BR_NET_EV_BROWSER_STATE = 8,  // a = BR_NET_STATE_*, ptr = error text
  BR_NET_EV_BROWSER_RESULTS = 9,// a = count, ptr = JSON: every result now
};

// States, BunKit's own numbers rather than Network.framework's — its three state
// enums number the same states differently, and JavaScript never sees them.
enum {
  BR_NET_STATE_STARTING = 1,    // preparing, or a listener or browser starting
  BR_NET_STATE_READY = 2,
  BR_NET_STATE_WAITING = 3,     // waiting for a path, or for permission
  BR_NET_STATE_FAILED = 4,
  BR_NET_STATE_CANCELLED = 5,
};

static int32_t listener_state(nw_listener_state_t s) {
  switch (s) {
    case nw_listener_state_ready: return BR_NET_STATE_READY;
    case nw_listener_state_waiting: return BR_NET_STATE_WAITING;
    case nw_listener_state_failed: return BR_NET_STATE_FAILED;
    case nw_listener_state_cancelled: return BR_NET_STATE_CANCELLED;
    default: return BR_NET_STATE_STARTING;
  }
}

static int32_t browser_state(nw_browser_state_t s) {
  switch (s) {
    case nw_browser_state_ready: return BR_NET_STATE_READY;
    case nw_browser_state_waiting: return BR_NET_STATE_WAITING;
    case nw_browser_state_failed: return BR_NET_STATE_FAILED;
    case nw_browser_state_cancelled: return BR_NET_STATE_CANCELLED;
    default: return BR_NET_STATE_STARTING;
  }
}

enum { KIND_CONN = 1, KIND_LISTENER = 2, KIND_BROWSER = 3 };

// The head every object starts with.
typedef struct BRNetObj {
  atomic_int refs;
  uint32_t id;
  int kind;
} BRNetObj;

typedef struct BRNetConn {
  BRNetObj base;
  nw_connection_t conn;        // +1; set on the queue
  uint32_t max_message;
  // Framing — queue only.
  uint8_t header[4];
  uint32_t header_have;
  uint8_t* body;
  uint32_t body_len;
  uint32_t body_have;
  int in_body;
  int receiving;               // a receive is outstanding
  int closing;                 // a cancel has been asked for, by anyone
  int reported_ready;
  char* close_reason;          // why we cancelled it ourselves, for the cancelled event
  // Flow control — any thread.
  atomic_llong undelivered;
  atomic_int paused;
} BRNetConn;

typedef struct BRNetListener {
  BRNetObj base;
  nw_listener_t listener;      // +1
  uint32_t max_message;
  char* name;
  char* type;
  int closing;                 // queue only
} BRNetListener;

typedef struct BRNetBrowser {
  BRNetObj base;
  nw_browser_t browser;        // +1
  NSMutableDictionary* results;// "name\ttype\tdomain" -> nw_browse_result_t; queue only
} BRNetBrowser;

typedef struct BRNetEvent {
  struct BRNetEvent* next;
  uint32_t kind;
  uint32_t id;
  int32_t a;
  uint64_t b;
  void* ptr;
  uint64_t len;
  BRNetConn* conn;             // a message's connection, for flow control (holds a ref)
} BRNetEvent;

static dispatch_queue_t g_queue;
static pthread_mutex_t g_events_lock = PTHREAD_MUTEX_INITIALIZER;
static BRNetEvent* g_head;
static BRNetEvent* g_tail;
static int g_notified;
static pthread_mutex_t g_notify_lock = PTHREAD_MUTEX_INITIALIZER;
static void (*g_notify)(void);
static atomic_uint g_next_id = 1;
static atomic_long g_live;

static dispatch_queue_t net_queue(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    dispatch_queue_attr_t attr = dispatch_queue_attr_make_with_qos_class(
        DISPATCH_QUEUE_SERIAL, QOS_CLASS_USER_INITIATED, 0);
    g_queue = dispatch_queue_create("bunkit.net", attr);
  });
  return g_queue;
}

static void obj_ref(BRNetObj* o) { atomic_fetch_add(&o->refs, 1); }
static void obj_unref(BRNetObj* o);

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

// Append an event and, if the list was empty since the last poll, wake
// JavaScript. Takes ownership of `ptr` (and of the reference `conn` carries).
static void emit(uint32_t kind, uint32_t id, int32_t a, uint64_t b, void* ptr, uint64_t len,
                 BRNetConn* conn) {
  BRNetEvent* e = calloc(1, sizeof(BRNetEvent));
  if (!e) {
    // Out of memory: drop it, and anything it owned.
    if (kind == BR_NET_EV_LISTENER_CONN && ptr) obj_unref((BRNetObj*)ptr);
    else free(ptr);
    if (conn) obj_unref(&conn->base);
    return;
  }
  e->kind = kind;
  e->id = id;
  e->a = a;
  e->b = b;
  e->ptr = ptr;
  e->len = len;
  e->conn = conn;
  pthread_mutex_lock(&g_events_lock);
  if (g_tail) g_tail->next = e;
  else g_head = e;
  g_tail = e;
  int wake = !g_notified;
  g_notified = 1;
  pthread_mutex_unlock(&g_events_lock);
  if (!wake) return;
  // BunKit's main loop: its work source fires inside the pump and inside any nested
  // loop AppKit is running — a menu, a live resize — and the turn takes the events
  // (docs/main-loop/spec.md §7.5). A pump asleep in AppKit comes back at once.
  atomic_fetch_or(&g_br_main.pending, BR_PENDING_NET);
  br_main_signal();
  // And Bun's loop, for a process that is not pumping, or net used from a thread:
  // whichever drains first takes the events. Under its own lock so br_net_shutdown
  // can be sure no call is in flight once it returns. The callback only queues a
  // task on Bun's loop; it never blocks.
  pthread_mutex_lock(&g_notify_lock);
  if (g_notify) g_notify();
  pthread_mutex_unlock(&g_notify_lock);
}

static char* copy_text(const char* s) { return s ? strdup(s) : NULL; }

// "description (domain code)", malloc'd, or NULL for no error.
static char* error_text(nw_error_t error) {
  if (!error) return NULL;
  char* out = NULL;
  @autoreleasepool {
    int code = nw_error_get_error_code(error);
    nw_error_domain_t domain = nw_error_get_error_domain(error);
    const char* d = domain == nw_error_domain_posix ? "POSIX"
                  : domain == nw_error_domain_dns ? "DNS"
                  : domain == nw_error_domain_tls ? "TLS" : "Network";
    NSString* text = nil;
    CFErrorRef cf = nw_error_copy_cf_error(error);
    if (cf) {
      text = [[(NSError*)cf localizedDescription] copy];
      CFRelease(cf);
    }
    const char* t = text ? [text UTF8String] : "error";
    if (asprintf(&out, "%s (%s %d)", t ? t : "error", d, code) < 0) out = NULL;
    [text release];
  }
  return out;
}

// JSON for `object`, NUL-terminated and malloc'd, or NULL.
static char* json_text(id object, uint64_t* length) {
  NSData* data = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
  if (!data) return NULL;
  char* out = malloc([data length] + 1);
  if (!out) return NULL;
  memcpy(out, [data bytes], [data length]);
  out[[data length]] = 0;
  if (length) *length = [data length];
  return out;
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

// Pre-shared keys, parsed out of the packed form JavaScript sends:
// repeated (u32 psk length, psk, u32 identity length, identity), little-endian.
typedef struct BRNetKeys {
  int count;
  dispatch_data_t psk[16];
  dispatch_data_t identity[16];
} BRNetKeys;

static void keys_parse(BRNetKeys* k, const uint8_t* blob, int32_t length) {
  memset(k, 0, sizeof(*k));
  if (!blob || length <= 0) return;
  int32_t at = 0;
  while (k->count < 16 && at + 4 <= length) {
    uint32_t pl;
    memcpy(&pl, blob + at, 4);
    at += 4;
    if (pl == 0 || at + (int64_t)pl + 4 > length) break;
    const uint8_t* p = blob + at;
    at += pl;
    uint32_t il;
    memcpy(&il, blob + at, 4);
    at += 4;
    if (il == 0 || at + (int64_t)il > length) break;
    k->psk[k->count] = dispatch_data_create(p, pl, NULL, DISPATCH_DATA_DESTRUCTOR_DEFAULT);
    k->identity[k->count] = dispatch_data_create(blob + at, il, NULL, DISPATCH_DATA_DESTRUCTOR_DEFAULT);
    at += il;
    k->count++;
  }
}

static void keys_release(BRNetKeys* k) {
  for (int i = 0; i < k->count; i++) {
    dispatch_release(k->psk[i]);
    dispatch_release(k->identity[i]);
  }
  k->count = 0;
}

// TCP, or TLS over TCP with pre-shared keys, with peer-to-peer interfaces
// allowed or not. +1.
//
// TLS with a pre-shared key is TLS 1.2, with TLS_ECDHE_PSK_WITH_CHACHA20_POLY1305_SHA256
// and nothing else: the key authenticates both ends, an ephemeral ECDH share gives
// each connection its own secret (forward secrecy), and ChaCha20-Poly1305 is an
// AEAD. TLS 1.3 would be better and does not work from here: measured on macOS
// 26.6, every TLS 1.3 configuration with sec_protocol_options_add_pre_shared_key —
// 1.3 alone, with its suites named or not, with an identity hint and a selection
// block — fails the handshake with -9858 even with the right key, and offered both
// versions it negotiates 1.2. Offering one suite leaves nothing to downgrade to.
static nw_parameters_t make_parameters(int peer_to_peer, BRNetKeys* keys) {
  int tls = keys && keys->count > 0;
  nw_parameters_configure_protocol_block_t configure_tls = ^(nw_protocol_options_t options) {
    sec_protocol_options_t sec = nw_tls_copy_sec_protocol_options(options);
    for (int i = 0; i < keys->count; i++) {
      sec_protocol_options_add_pre_shared_key(sec, keys->psk[i], keys->identity[i]);
    }
    sec_protocol_options_set_min_tls_protocol_version(sec, tls_protocol_version_TLSv12);
    sec_protocol_options_set_max_tls_protocol_version(sec, tls_protocol_version_TLSv12);
    sec_protocol_options_append_tls_ciphersuite(sec, (tls_ciphersuite_t)TLS_ECDHE_PSK_WITH_CHACHA20_POLY1305_SHA256);
    sec_release(sec);
  };
  nw_parameters_configure_protocol_block_t configure_tcp = ^(nw_protocol_options_t options) {
    // Messages are often small and answered: don't hold them for Nagle.
    nw_tcp_options_set_no_delay(options, true);
    // A peer that walks out of range is noticed in about 16 s, not hours.
    nw_tcp_options_set_enable_keepalive(options, true);
    nw_tcp_options_set_keepalive_idle_time(options, 10);
    nw_tcp_options_set_keepalive_interval(options, 2);
    nw_tcp_options_set_keepalive_count(options, 3);
  };
  nw_parameters_t parameters = nw_parameters_create_secure_tcp(
      tls ? configure_tls : NW_PARAMETERS_DISABLE_PROTOCOL, configure_tcp);
  nw_parameters_set_include_peer_to_peer(parameters, peer_to_peer ? true : false);
  return parameters;
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

static void conn_destroy(BRNetConn* c) {
  if (c->conn) nw_release(c->conn);
  free(c->body);
  free(c->close_reason);
  free(c);
  atomic_fetch_sub(&g_live, 1);
}

// A connection with no nw_connection yet: one reference for JavaScript, one for
// its life on the queue.
static BRNetConn* conn_alloc(uint32_t max_message) {
  BRNetConn* c = calloc(1, sizeof(BRNetConn));
  if (!c) return NULL;
  atomic_init(&c->base.refs, 2);
  c->base.id = atomic_fetch_add(&g_next_id, 1);
  c->base.kind = KIND_CONN;
  c->max_message = max_message && max_message < BR_NET_MAX_MESSAGE ? max_message : BR_NET_MAX_MESSAGE;
  atomic_fetch_add(&g_live, 1);
  return c;
}

// Cancel it, with `reason` reported when it is cancelled. Queue only.
static void conn_cancel(BRNetConn* c, const char* reason) {
  if (c->closing) return;
  c->closing = 1;
  if (reason && !c->close_reason) c->close_reason = strdup(reason);
  if (c->conn) nw_connection_cancel(c->conn);
}

// Fail it: report `why` as a failure now, then cancel. Queue only.
static void conn_fail(BRNetConn* c, const char* why) {
  if (c->closing) return;
  emit(BR_NET_EV_CONN_STATE, c->base.id, BR_NET_STATE_FAILED, 0, copy_text(why), 0, NULL);
  conn_cancel(c, NULL);
}

static const char* interface_type_name(nw_interface_type_t type) {
  switch (type) {
    case nw_interface_type_wifi: return "wifi";
    case nw_interface_type_cellular: return "cellular";
    case nw_interface_type_wired: return "wired";
    case nw_interface_type_loopback: return "loopback";
    default: return "other";
  }
}

// AWDL's interfaces: awdl0 for the link, llw0 for its low-latency companion.
static BOOL is_peer_to_peer_interface(const char* name) {
  return name && (strncmp(name, "awdl", 4) == 0 || strncmp(name, "llw", 3) == 0);
}

static NSString* endpoint_text(nw_endpoint_t endpoint) {
  if (!endpoint) return nil;
  NSString* text = nil;
  if (nw_endpoint_get_type(endpoint) == nw_endpoint_type_address) {
    char* address = nw_endpoint_copy_address_string(endpoint);
    if (address) {
      text = [NSString stringWithFormat:@"%s:%u", address, nw_endpoint_get_port(endpoint)];
      free(address);
    }
  } else if (nw_endpoint_get_type(endpoint) == nw_endpoint_type_host) {
    text = [NSString stringWithFormat:@"%s:%u", nw_endpoint_get_hostname(endpoint), nw_endpoint_get_port(endpoint)];
  }
  return text;
}

// What route it took and what TLS it negotiated, as JSON. Queue only.
static void conn_report_info(BRNetConn* c) {
  @autoreleasepool {
    NSMutableDictionary* info = [NSMutableDictionary dictionary];
    nw_path_t path = nw_connection_copy_current_path(c->conn);
    if (path) {
      // The name belongs to the interface object, so it is copied while that is alive.
      char name[IFNAMSIZ_COPY] = {0};
      char* namep = name;
      __block nw_interface_type_t type = nw_interface_type_other;
      nw_path_enumerate_interfaces(path, ^bool(nw_interface_t interface) {
        const char* n = nw_interface_get_name(interface);
        if (n) strlcpy(namep, n, IFNAMSIZ_COPY);
        type = nw_interface_get_type(interface);
        return false; // the first is the one in use
      });
      if (name[0]) info[@"interface"] = [NSString stringWithUTF8String:name];
      info[@"interfaceType"] = [NSString stringWithUTF8String:interface_type_name(type)];
      info[@"peerToPeer"] = @(is_peer_to_peer_interface(name[0] ? name : NULL));
      info[@"wired"] = @(nw_path_uses_interface_type(path, nw_interface_type_wired));
      info[@"loopback"] = @(nw_path_uses_interface_type(path, nw_interface_type_loopback));
      nw_endpoint_t local = nw_path_copy_effective_local_endpoint(path);
      nw_endpoint_t remote = nw_path_copy_effective_remote_endpoint(path);
      NSString* l = endpoint_text(local);
      NSString* r = endpoint_text(remote);
      if (l) info[@"local"] = l;
      if (r) info[@"remote"] = r;
      if (local) nw_release(local);
      if (remote) nw_release(remote);
      nw_release(path);
    }
    nw_protocol_definition_t tls = nw_protocol_copy_tls_definition();
    nw_protocol_metadata_t metadata = nw_connection_copy_protocol_metadata(c->conn, tls);
    if (metadata) {
      sec_protocol_metadata_t sec = nw_tls_copy_sec_protocol_metadata(metadata);
      if (sec) {
        tls_protocol_version_t v = sec_protocol_metadata_get_negotiated_tls_protocol_version(sec);
        info[@"tlsVersion"] = v == tls_protocol_version_TLSv13 ? @"TLS 1.3"
                            : v == tls_protocol_version_TLSv12 ? @"TLS 1.2"
                            : [NSString stringWithFormat:@"0x%04x", (unsigned)v];
        info[@"tlsCiphersuite"] = @(sec_protocol_metadata_get_negotiated_tls_ciphersuite(sec));
        sec_release(sec);
      }
      nw_release(metadata);
    }
    nw_release(tls);
    uint64_t length = 0;
    char* json = json_text(info, &length);
    if (json) emit(BR_NET_EV_CONN_INFO, c->base.id, 0, 0, json, length, NULL);
  }
}

static void conn_receive(BRNetConn* c);

// A whole message: hand it over, counting it against the high-water mark.
static void conn_deliver(BRNetConn* c, uint8_t* bytes, uint32_t length) {
  atomic_fetch_add(&c->undelivered, (long long)length + BR_NET_MESSAGE_OVERHEAD);
  obj_ref(&c->base);
  emit(BR_NET_EV_CONN_MESSAGE, c->base.id, 0, 0, bytes, length, c);
}

// Feed received bytes through the framing. False once the connection has failed.
static bool conn_feed(BRNetConn* c, const uint8_t* bytes, size_t size) {
  while (size > 0) {
    if (!c->in_body) {
      size_t take = 4 - c->header_have;
      if (take > size) take = size;
      memcpy(c->header + c->header_have, bytes, take);
      c->header_have += (uint32_t)take;
      bytes += take;
      size -= take;
      if (c->header_have < 4) break;
      c->header_have = 0;
      uint32_t length = ((uint32_t)c->header[0] << 24) | ((uint32_t)c->header[1] << 16) |
                        ((uint32_t)c->header[2] << 8) | (uint32_t)c->header[3];
      if (length > c->max_message) {
        char why[160];
        // A TLS record (handshake 0x16 or alert 0x15, version 3.x) where a length
        // should be: one end has a key and the other does not.
        if ((c->header[0] == 0x15 || c->header[0] == 0x16) && c->header[1] == 0x03) {
          snprintf(why, sizeof why, "The peer is using TLS and this end isn't. Both ends need the same key.");
        } else {
          snprintf(why, sizeof why, "The peer sent a message of %u bytes, over the limit of %u.",
                   length, c->max_message);
        }
        conn_fail(c, why);
        return false;
      }
      if (length == 0) {
        conn_deliver(c, NULL, 0);
        continue;
      }
      c->body = malloc(length);
      if (!c->body) {
        conn_fail(c, "Out of memory for a received message.");
        return false;
      }
      c->body_len = length;
      c->body_have = 0;
      c->in_body = 1;
    } else {
      size_t take = c->body_len - c->body_have;
      if (take > size) take = size;
      memcpy(c->body + c->body_have, bytes, take);
      c->body_have += (uint32_t)take;
      bytes += take;
      size -= take;
      if (c->body_have == c->body_len) {
        uint8_t* body = c->body;
        c->body = NULL;
        c->in_body = 0;
        conn_deliver(c, body, c->body_len);
      }
    }
  }
  return true;
}

// Ask for the next chunk, unless one is outstanding, the connection is closing,
// or JavaScript has not taken enough of what came already. Queue only.
static void conn_receive(BRNetConn* c) {
  if (c->receiving || c->closing || !c->conn) return;
  if (atomic_load(&c->undelivered) >= BR_NET_HIGH_WATER) {
    // Paused first, then looked again: JavaScript may have taken everything in
    // between, and it only resumes a connection it sees paused. One side or the
    // other sees the other's write, so reading never stops for good.
    atomic_store(&c->paused, 1);
    if (atomic_load(&c->undelivered) >= BR_NET_HIGH_WATER) return;
    atomic_store(&c->paused, 0);
  }
  c->receiving = 1;
  obj_ref(&c->base);
  nw_connection_receive(c->conn, 1, BR_NET_RECEIVE_CHUNK,
                        ^(dispatch_data_t content, nw_content_context_t context, bool complete,
                          nw_error_t error) {
    c->receiving = 0;
    __block bool ok = true;
    if (content && !c->closing) {
      dispatch_data_apply(content, ^bool(dispatch_data_t region, size_t offset, const void* buffer,
                                         size_t size) {
        ok = conn_feed(c, buffer, size);
        return ok;
      });
    }
    if (ok && !c->closing) {
      if (error) {
        // Reported here, with its reason: the state handler may come second, and
        // stays quiet about a connection already closing.
        char* why = error_text(error);
        conn_fail(c, why ? why : "The connection failed while receiving.");
        free(why);
      } else if (complete && (!context || nw_content_context_get_is_final(context))) {
        // The peer closed its side.
        if (c->in_body || c->header_have) conn_fail(c, "The peer closed the connection in the middle of a message.");
        else conn_cancel(c, "The peer closed the connection.");
      } else {
        conn_receive(c);
      }
    }
    obj_unref(&c->base);
  });
}

static void conn_state(BRNetConn* c, nw_connection_state_t state, nw_error_t error) {
  switch (state) {
    case nw_connection_state_ready:
      if (!c->reported_ready) {
        c->reported_ready = 1;
        conn_report_info(c);
        emit(BR_NET_EV_CONN_STATE, c->base.id, BR_NET_STATE_READY, 0, NULL, 0, NULL);
        conn_receive(c);
      }
      break;
    case nw_connection_state_failed:
      if (!c->closing) {
        emit(BR_NET_EV_CONN_STATE, c->base.id, BR_NET_STATE_FAILED, 0, error_text(error), 0, NULL);
        conn_cancel(c, NULL);
      }
      break;
    case nw_connection_state_cancelled: {
      char* reason = c->close_reason;
      c->close_reason = NULL;
      emit(BR_NET_EV_CONN_STATE, c->base.id, BR_NET_STATE_CANCELLED, 0, reason, 0, NULL);
      obj_unref(&c->base); // its life on the queue is over
      break;
    }
    case nw_connection_state_waiting:
      if (c->closing) break;
      // Network.framework waits — and retries — after a failed TLS handshake, but a
      // wrong key never comes right: report it as the failure it is.
      if (error && nw_error_get_error_domain(error) == nw_error_domain_tls) {
        char* why = error_text(error);
        conn_fail(c, why);
        free(why);
        break;
      }
      // It also waits, for a path change that on loopback never comes, when its local
      // port is refused: Network.framework picks the port itself, and with both ends
      // on one Mac drawing from one pool it can pick one still held in TIME_WAIT by a
      // connection closed seconds ago. Measured at about one connection in three
      // thousand, at two hundred a second, both ends in one process. Fail it, so a
      // caller that reconnects (on another port) is not left waiting for good.
      if (error && nw_error_get_error_domain(error) == nw_error_domain_posix &&
          nw_error_get_error_code(error) == EADDRINUSE) {
        char* why = error_text(error);
        conn_fail(c, why);
        free(why);
        break;
      }
      emit(BR_NET_EV_CONN_STATE, c->base.id, BR_NET_STATE_WAITING, 0, error_text(error), 0, NULL);
      break;
    case nw_connection_state_preparing:
      if (!c->closing) emit(BR_NET_EV_CONN_STATE, c->base.id, BR_NET_STATE_STARTING, 0, error_text(error), 0, NULL);
      break;
    default:
      break;
  }
}

// Give `c` its nw_connection (+1, adopted) and start it. Queue only.
static void conn_attach(BRNetConn* c, nw_connection_t connection) {
  c->conn = connection;
  nw_connection_set_queue(connection, net_queue());
  nw_connection_set_state_changed_handler(connection, ^(nw_connection_state_t state, nw_error_t error) {
    conn_state(c, state, error);
  });
  nw_connection_set_path_changed_handler(connection, ^(nw_path_t path) {
    if (c->reported_ready && !c->closing) conn_report_info(c);
  });
  nw_connection_start(connection);
}

// JavaScript took a message: count it off, and read again if reading had stopped.
static void conn_taken(BRNetConn* c, uint64_t length) {
  long long left = atomic_fetch_sub(&c->undelivered, (long long)length + BR_NET_MESSAGE_OVERHEAD) -
                   ((long long)length + BR_NET_MESSAGE_OVERHEAD);
  if (left < BR_NET_LOW_WATER && atomic_load(&c->paused)) {
    obj_ref(&c->base);
    dispatch_async(net_queue(), ^{
      if (atomic_exchange(&c->paused, 0)) conn_receive(c);
      obj_unref(&c->base);
    });
  }
}

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------

static void listener_destroy(BRNetListener* l) {
  if (l->listener) nw_release(l->listener);
  free(l->name);
  free(l->type);
  free(l);
  atomic_fetch_sub(&g_live, 1);
}

// A Bonjour advertisement for `l` with this TXT record (DNS wire format). +1.
static nw_advertise_descriptor_t listener_advertisement(BRNetListener* l, const uint8_t* txt, int32_t txt_len) {
  if (!l->name || !l->type) return NULL;
  nw_advertise_descriptor_t ad = nw_advertise_descriptor_create_bonjour_service(l->name, l->type, NULL);
  if (ad && txt && txt_len > 0) nw_advertise_descriptor_set_txt_record(ad, txt, (size_t)txt_len);
  return ad;
}

// ---------------------------------------------------------------------------
// Browsers
// ---------------------------------------------------------------------------

static void browser_destroy(BRNetBrowser* b) {
  if (b->browser) nw_release(b->browser);
  [b->results release];
  free(b);
  atomic_fetch_sub(&g_live, 1);
}

static NSString* result_key_parts(const char* name, const char* type, const char* domain) {
  return [NSString stringWithFormat:@"%s\t%s\t%s", name ? name : "", type ? type : "", domain ? domain : ""];
}

static NSString* result_key(nw_browse_result_t result) {
  nw_endpoint_t endpoint = nw_browse_result_copy_endpoint(result);
  NSString* key = result_key_parts(nw_endpoint_get_bonjour_service_name(endpoint),
                                   nw_endpoint_get_bonjour_service_type(endpoint),
                                   nw_endpoint_get_bonjour_service_domain(endpoint));
  nw_release(endpoint);
  return key;
}

// A string for TXT bytes: UTF-8 when they are, Latin-1 (which always decodes) when not.
static NSString* txt_string(const uint8_t* bytes, size_t length) {
  if (!bytes || length == 0) return @"";
  NSString* s = [[[NSString alloc] initWithBytes:bytes length:length encoding:NSUTF8StringEncoding] autorelease];
  if (!s) s = [[[NSString alloc] initWithBytes:bytes length:length encoding:NSISOLatin1StringEncoding] autorelease];
  return s ? s : @"";
}

// Every result the browser has now, as JSON. Queue only.
static void browser_report(BRNetBrowser* b) {
  @autoreleasepool {
    NSMutableArray* list = [NSMutableArray array];
    for (NSString* key in [[b->results allKeys] sortedArrayUsingSelector:@selector(compare:)]) {
      nw_browse_result_t result = b->results[key];
      nw_endpoint_t endpoint = nw_browse_result_copy_endpoint(result);
      const char* name = nw_endpoint_get_bonjour_service_name(endpoint);
      const char* type = nw_endpoint_get_bonjour_service_type(endpoint);
      const char* domain = nw_endpoint_get_bonjour_service_domain(endpoint);
      NSMutableDictionary* txt = [NSMutableDictionary dictionary];
      nw_txt_record_t record = nw_browse_result_copy_txt_record_object(result);
      if (record) {
        nw_txt_record_apply(record, ^bool(const char* k, nw_txt_record_find_key_t found,
                                          const uint8_t* value, size_t value_len) {
          if (k) txt[[NSString stringWithUTF8String:k] ?: @""] = txt_string(value, value_len);
          return true;
        });
        nw_release(record);
      }
      NSMutableArray* interfaces = [NSMutableArray array];
      nw_browse_result_enumerate_interfaces(result, ^bool(nw_interface_t interface) {
        const char* n = nw_interface_get_name(interface);
        [interfaces addObject:@{
          @"name" : n ? [NSString stringWithUTF8String:n] : @"",
          @"type" : [NSString stringWithUTF8String:interface_type_name(nw_interface_get_type(interface))],
          @"peerToPeer" : @(is_peer_to_peer_interface(n)),
        }];
        return true;
      });
      [list addObject:@{
        @"name" : name ? [NSString stringWithUTF8String:name] : @"",
        @"type" : type ? [NSString stringWithUTF8String:type] : @"",
        @"domain" : domain ? [NSString stringWithUTF8String:domain] : @"",
        @"txt" : txt,
        @"interfaces" : interfaces,
      }];
      nw_release(endpoint);
    }
    uint64_t length = 0;
    char* json = json_text(list, &length);
    if (json) emit(BR_NET_EV_BROWSER_RESULTS, b->base.id, (int32_t)[list count], 0, json, length, NULL);
  }
}

// ---------------------------------------------------------------------------
// Lifetime
// ---------------------------------------------------------------------------

static void obj_unref(BRNetObj* o) {
  if (atomic_fetch_sub(&o->refs, 1) != 1) return;
  switch (o->kind) {
    case KIND_CONN: conn_destroy((BRNetConn*)o); break;
    case KIND_LISTENER: listener_destroy((BRNetListener*)o); break;
    case KIND_BROWSER: browser_destroy((BRNetBrowser*)o); break;
  }
}

// ---------------------------------------------------------------------------
// The exported surface
// ---------------------------------------------------------------------------

void br_net_init(void* notify) {
  pthread_mutex_lock(&g_notify_lock);
  g_notify = (void (*)(void))notify;
  pthread_mutex_unlock(&g_notify_lock);
  net_queue();
}

void br_net_shutdown(void) {
  pthread_mutex_lock(&g_notify_lock);
  g_notify = NULL;
  pthread_mutex_unlock(&g_notify_lock);
}

// Record layout, 40 bytes, little-endian: u32 kind, u32 id, i32 a, u32 0,
// u64 b, u64 ptr, u64 len.
int32_t br_net_poll(void* out, int32_t cap) {
  if (!out || cap <= 0) return 0;
  BRNetEvent* taken = NULL;
  BRNetEvent** link = &taken;
  int32_t n = 0;
  pthread_mutex_lock(&g_events_lock);
  while (g_head && n < cap) {
    BRNetEvent* e = g_head;
    g_head = e->next;
    e->next = NULL;
    *link = e;
    link = &e->next;
    n++;
  }
  if (!g_head) {
    g_tail = NULL;
    g_notified = 0; // the next event wakes JavaScript again
  }
  pthread_mutex_unlock(&g_events_lock);
  uint8_t* record = (uint8_t*)out;
  for (BRNetEvent* e = taken; e;) {
    uint32_t zero = 0;
    uint64_t p = (uint64_t)(uintptr_t)e->ptr;
    memcpy(record + 0, &e->kind, 4);
    memcpy(record + 4, &e->id, 4);
    memcpy(record + 8, &e->a, 4);
    memcpy(record + 12, &zero, 4);
    memcpy(record + 16, &e->b, 8);
    memcpy(record + 24, &p, 8);
    memcpy(record + 32, &e->len, 8);
    record += 40;
    if (e->conn) {
      conn_taken(e->conn, e->len);
      obj_unref(&e->conn->base);
    }
    BRNetEvent* next = e->next;
    free(e);
    e = next;
  }
  return n;
}

// The deallocator JavaScript gives toArrayBuffer for a received message.
void br_net_release_bytes(void* bytes, void* context) { free(bytes); }

uint32_t br_net_id(void* handle) { return handle ? ((BRNetObj*)handle)->id : 0; }

long br_net_live(void) { return atomic_load(&g_live); }

void* br_net_listen(const char* type, const char* name, const void* txt, int32_t txt_len,
                    int32_t peer_to_peer, const void* keys, int32_t keys_len,
                    uint32_t max_message, int32_t port) {
  BRNetListener* l = calloc(1, sizeof(BRNetListener));
  if (!l) return NULL;
  atomic_init(&l->base.refs, 2); // JavaScript's, and its life on the queue
  l->base.id = atomic_fetch_add(&g_next_id, 1);
  l->base.kind = KIND_LISTENER;
  l->max_message = max_message && max_message < BR_NET_MAX_MESSAGE ? max_message : BR_NET_MAX_MESSAGE;
  // No name or type: a plain listener, not advertised (reached by address).
  l->name = name && type ? strdup(name) : NULL;
  l->type = name && type ? strdup(type) : NULL;
  atomic_fetch_add(&g_live, 1);

  BRNetKeys k;
  keys_parse(&k, keys, keys_len);
  nw_parameters_t parameters = make_parameters(peer_to_peer, &k);
  keys_release(&k);
  nw_listener_t listener = NULL;
  if (port > 0 && port < 65536) {
    // A fixed port is taken again at once after a restart, whatever connections
    // to it are still in TIME_WAIT — the usual thing for a server. Not for a
    // connection's own port: there it lets the kernel hand out a port still in
    // TIME_WAIT, and on one Mac that collides with the closed connection itself.
    nw_parameters_set_reuse_local_address(parameters, true);
    char p[8];
    snprintf(p, sizeof p, "%d", port);
    listener = nw_listener_create_with_port(p, parameters);
  } else {
    listener = nw_listener_create(parameters);
  }
  nw_release(parameters);
  if (!listener) {
    listener_destroy(l);
    return NULL;
  }
  l->listener = listener;
  nw_advertise_descriptor_t ad = listener_advertisement(l, txt, txt_len);
  if (ad) {
    nw_listener_set_advertise_descriptor(listener, ad);
    nw_release(ad);
  }
  nw_listener_set_queue(listener, net_queue());
  nw_listener_set_state_changed_handler(listener, ^(nw_listener_state_t state, nw_error_t error) {
    switch (state) {
      case nw_listener_state_ready:
        emit(BR_NET_EV_LISTENER_STATE, l->base.id, BR_NET_STATE_READY, nw_listener_get_port(l->listener), NULL, 0, NULL);
        break;
      case nw_listener_state_failed:
        emit(BR_NET_EV_LISTENER_STATE, l->base.id, BR_NET_STATE_FAILED, 0, error_text(error), 0, NULL);
        if (!l->closing) {
          l->closing = 1;
          nw_listener_cancel(l->listener);
        }
        break;
      case nw_listener_state_cancelled:
        emit(BR_NET_EV_LISTENER_STATE, l->base.id, BR_NET_STATE_CANCELLED, 0, NULL, 0, NULL);
        obj_unref(&l->base);
        break;
      default:
        emit(BR_NET_EV_LISTENER_STATE, l->base.id, listener_state(state), 0, error_text(error), 0, NULL);
        break;
    }
  });
  nw_listener_set_new_connection_handler(listener, ^(nw_connection_t connection) {
    if (l->closing) {
      nw_connection_cancel(connection);
      return;
    }
    BRNetConn* c = conn_alloc(l->max_message);
    if (!c) {
      nw_connection_cancel(connection);
      return;
    }
    // Announced before it is started, so every event of its own comes after.
    emit(BR_NET_EV_LISTENER_CONN, l->base.id, 0, c->base.id, c, 0, NULL);
    conn_attach(c, (nw_connection_t)nw_retain(connection));
  });
  nw_listener_set_advertised_endpoint_changed_handler(listener, ^(nw_endpoint_t endpoint, bool added) {
    if (!added || !endpoint) return;
    const char* advertised = nw_endpoint_get_bonjour_service_name(endpoint);
    if (advertised) emit(BR_NET_EV_LISTENER_NAME, l->base.id, 0, 0, strdup(advertised), strlen(advertised), NULL);
  });
  nw_listener_start(listener);
  return l;
}

void br_net_listener_set_txt(void* handle, const void* txt, int32_t txt_len) {
  BRNetListener* l = (BRNetListener*)handle;
  if (!l || l->base.kind != KIND_LISTENER) return;
  void* copy = NULL;
  if (txt && txt_len > 0) {
    copy = malloc((size_t)txt_len);
    if (!copy) return;
    memcpy(copy, txt, (size_t)txt_len);
  }
  obj_ref(&l->base);
  dispatch_async(net_queue(), ^{
    if (!l->closing) {
      nw_advertise_descriptor_t ad = listener_advertisement(l, copy, copy ? txt_len : 0);
      if (ad) {
        nw_listener_set_advertise_descriptor(l->listener, ad);
        nw_release(ad);
      }
    }
    free(copy);
    obj_unref(&l->base);
  });
}

void* br_net_browse(const char* type, int32_t peer_to_peer) {
  if (!type) return NULL;
  BRNetBrowser* b = calloc(1, sizeof(BRNetBrowser));
  if (!b) return NULL;
  atomic_init(&b->base.refs, 2);
  b->base.id = atomic_fetch_add(&g_next_id, 1);
  b->base.kind = KIND_BROWSER;
  b->results = [[NSMutableDictionary alloc] init];
  atomic_fetch_add(&g_live, 1);
  nw_browse_descriptor_t descriptor = nw_browse_descriptor_create_bonjour_service(type, NULL);
  nw_browse_descriptor_set_include_txt_record(descriptor, true);
  nw_parameters_t parameters = nw_parameters_create();
  nw_parameters_set_include_peer_to_peer(parameters, peer_to_peer ? true : false);
  nw_browser_t browser = nw_browser_create(descriptor, parameters);
  nw_release(descriptor);
  nw_release(parameters);
  if (!browser) {
    browser_destroy(b);
    return NULL;
  }
  b->browser = browser;
  nw_browser_set_queue(browser, net_queue());
  nw_browser_set_state_changed_handler(browser, ^(nw_browser_state_t state, nw_error_t error) {
    emit(BR_NET_EV_BROWSER_STATE, b->base.id, browser_state(state), 0, error_text(error), 0, NULL);
    if (state == nw_browser_state_failed) nw_browser_cancel(b->browser);
    if (state == nw_browser_state_cancelled) obj_unref(&b->base);
  });
  nw_browser_set_browse_results_changed_handler(browser, ^(nw_browse_result_t old_result,
                                                           nw_browse_result_t new_result,
                                                           bool batch_complete) {
    @autoreleasepool {
      if (old_result) [b->results removeObjectForKey:result_key(old_result)];
      if (new_result) b->results[result_key(new_result)] = (id)new_result;
    }
    if (batch_complete) browser_report(b);
  });
  nw_browser_start(browser);
  return b;
}

void* br_net_connect(void* browser_handle, const char* name, const char* type, const char* domain,
                     const char* host, int32_t port, int32_t peer_to_peer, const void* keys,
                     int32_t keys_len, uint32_t max_message) {
  if (!(name && type) && !(host && port > 0)) return NULL;
  BRNetConn* c = conn_alloc(max_message);
  if (!c) return NULL;
  BRNetBrowser* b = (BRNetBrowser*)browser_handle;
  if (b && b->base.kind != KIND_BROWSER) b = NULL;
  if (b) obj_ref(&b->base);
  char* n = copy_text(name);
  char* t = copy_text(type);
  char* d = copy_text(domain && *domain ? domain : "local.");
  char* h = copy_text(host);
  BRNetKeys* k = malloc(sizeof(BRNetKeys));
  if (k) keys_parse(k, keys, keys_len);
  obj_ref(&c->base);
  dispatch_async(net_queue(), ^{
    nw_endpoint_t endpoint = NULL;
    if (n && t) {
      @autoreleasepool {
        // The browser's own result carries the interfaces it was seen on.
        nw_browse_result_t result = b ? b->results[result_key_parts(n, t, d)] : nil;
        endpoint = result ? nw_browse_result_copy_endpoint(result) : nw_endpoint_create_bonjour_service(n, t, d);
      }
    } else {
      char p[8];
      snprintf(p, sizeof p, "%d", port);
      endpoint = nw_endpoint_create_host(h, p);
    }
    nw_parameters_t parameters = make_parameters(peer_to_peer, k);
    nw_connection_t connection = endpoint ? nw_connection_create(endpoint, parameters) : NULL;
    if (endpoint) nw_release(endpoint);
    nw_release(parameters);
    if (connection && !c->closing) {
      conn_attach(c, connection);
    } else {
      if (connection) nw_release(connection);
      if (!c->closing) {
        emit(BR_NET_EV_CONN_STATE, c->base.id, BR_NET_STATE_FAILED, 0,
             strdup("Couldn't make a connection to that peer."), 0, NULL);
      }
      emit(BR_NET_EV_CONN_STATE, c->base.id, BR_NET_STATE_CANCELLED, 0, NULL, 0, NULL);
      c->closing = 1;
      obj_unref(&c->base); // its life on the queue, which never began
    }
    if (k) {
      keys_release(k);
      free(k);
    }
    free(n);
    free(t);
    free(d);
    free(h);
    if (b) obj_unref(&b->base);
    obj_unref(&c->base);
  });
  return c;
}

int32_t br_net_send(void* handle, const void* bytes, uint32_t length, uint64_t sequence) {
  BRNetConn* c = (BRNetConn*)handle;
  if (!c || c->base.kind != KIND_CONN) return -1;
  if (length > c->max_message) return -2;
  uint8_t* frame = malloc(4 + (size_t)length);
  if (!frame) return -3;
  frame[0] = (uint8_t)(length >> 24);
  frame[1] = (uint8_t)(length >> 16);
  frame[2] = (uint8_t)(length >> 8);
  frame[3] = (uint8_t)length;
  if (length) memcpy(frame + 4, bytes, length);
  // The frame is ours now; Network.framework frees it when it is done with it.
  dispatch_data_t data = dispatch_data_create(frame, 4 + (size_t)length, net_queue(), DISPATCH_DATA_DESTRUCTOR_FREE);
  uint32_t id = c->base.id;
  obj_ref(&c->base);
  dispatch_async(net_queue(), ^{
    if (!c->conn) {
      emit(BR_NET_EV_CONN_SENT, id, 1, sequence, strdup("The connection is closed."), 0, NULL);
      obj_unref(&c->base);
      return;
    }
    nw_connection_send(c->conn, data, NW_CONNECTION_DEFAULT_MESSAGE_CONTEXT, true, ^(nw_error_t error) {
      emit(BR_NET_EV_CONN_SENT, id, error ? 1 : 0, sequence, error_text(error), 0, NULL);
      obj_unref(&c->base);
    });
  });
  dispatch_release(data); // the block holds it now
  return 0;
}

void br_net_close(void* handle) {
  BRNetObj* o = (BRNetObj*)handle;
  if (!o) return;
  obj_ref(o);
  dispatch_async(net_queue(), ^{
    switch (o->kind) {
      case KIND_CONN: {
        BRNetConn* c = (BRNetConn*)o;
        if (c->closing || !c->conn) break;
        if (!c->reported_ready) {
          conn_cancel(c, NULL);
          break;
        }
        // Let what is queued go first, then a FIN, then cancel — or cancel anyway
        // once the grace is up, for a peer that has stopped reading. Whichever
        // comes first cancels the timer, whose cancel handler lets go of it.
        c->closing = 1;
        dispatch_source_t grace = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, net_queue());
        obj_ref(o);
        dispatch_source_set_timer(grace, dispatch_time(DISPATCH_TIME_NOW, (int64_t)BR_NET_CLOSE_GRACE_NS),
                                  DISPATCH_TIME_FOREVER, 100 * NSEC_PER_MSEC);
        dispatch_source_set_event_handler(grace, ^{
          nw_connection_cancel(c->conn);
          dispatch_source_cancel(grace);
        });
        dispatch_source_set_cancel_handler(grace, ^{
          obj_unref(o);
        });
        dispatch_resume(grace);
        obj_ref(o);
        nw_connection_send(c->conn, NULL, NW_CONNECTION_FINAL_MESSAGE_CONTEXT, true, ^(nw_error_t error) {
          nw_connection_cancel(c->conn);
          dispatch_source_cancel(grace);
          obj_unref(o);
        });
        // The handlers hold it now (a source's handlers are released once it is cancelled).
        dispatch_release(grace);
        break;
      }
      case KIND_LISTENER: {
        BRNetListener* l = (BRNetListener*)o;
        if (!l->closing) {
          l->closing = 1;
          nw_listener_cancel(l->listener);
        }
        break;
      }
      case KIND_BROWSER:
        nw_browser_cancel(((BRNetBrowser*)o)->browser);
        break;
    }
    obj_unref(o);
  });
}

void br_net_free(void* handle) {
  BRNetObj* o = (BRNetObj*)handle;
  if (!o) return;
  obj_unref(o);
}
