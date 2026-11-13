// mainloop.m — BunKit's main loop, native side (docs/main-loop/spec.md §4–§8).
//
// Everything here is on the main run loop, in kCFRunLoopCommonModes, so it runs inside every
// nested loop AppKit enters from event dispatch (menus, live resize, control tracking, modal
// sessions):
//
// - the work source: one version-0 source, signalled whenever there is work — a task posted from
//   JavaScript, a message from a thread, a finished trampolined call, an event from net.m;
// - the deadline timer, re-armed after every turn to the main loop's earliest timer;
// - the frame clocks: one display link per screen (§5);
// - an observer that sees every run-loop entry and exit, which is how nesting is measured and how
//   a nested loop started with JavaScript on the stack is caught (§6.2).
//
// When any of them fires, JavaScript's turn() is called **only at a safe point**: inside br_pump,
// with no native → JavaScript call in progress and no turn running (§3). Anywhere else the turn is
// left pending, and br_pump runs it at its next safe point.
//
// Run-loop modes are named with the frameworks' own symbols, never strings made at runtime:
// CFRunLoop recognises kCFRunLoopCommonModes by pointer, and a copy is taken for an ordinary mode
// that nothing runs (§13, open question 1).

#import <Cocoa/Cocoa.h>
#import <QuartzCore/QuartzCore.h>
#include <pthread.h>
#include <stdatomic.h>
#include <string.h>
#include "bridge.h"

br_main_state g_br_main;
br_clock_slot g_br_clocks[BR_MAX_CLOCKS];

typedef void (*br_turn_fn)(void);
typedef void (*br_stack_fn)(uint32_t);
typedef void (*br_wake_fn)(void);

static br_turn_fn g_turn;
static br_stack_fn g_stack;
static pthread_mutex_t g_wake_lock = PTHREAD_MUTEX_INITIALIZER;
static br_wake_fn g_wake;
static CFRunLoopRef g_rl;
static CFRunLoopSourceRef g_source;
static CFRunLoopTimerRef g_deadline;
static double g_armed_due = -1;  // the JavaScript-clock due time the deadline timer is armed for

void* br_main_state_ptr(void) { return &g_br_main; }
void* br_main_clocks_ptr(void) { return g_br_clocks; }

#define LOAD(f) atomic_load_explicit(&(f), memory_order_relaxed)

int br_main_is_safe(void) {
  return LOAD(g_br_main.inPump) > 0 && LOAD(g_br_main.callbackDepth) == 0 &&
         LOAD(g_br_main.inTurn) == 0;
}

// ---------------------------------------------------------------------------
// Statistics (§8)
// ---------------------------------------------------------------------------

#define MAX_MODES 16
static char* g_mode_names[MAX_MODES];
static CFStringRef g_modes[MAX_MODES];
static int g_mode_count;

typedef struct {
  double count, totalMs, longestMs;
} br_mode_stats;

static struct {
  double nestedCount, nestedTotalMs, nestedLongestMs, nestedFromJs;
  double pumpLongestMs;
  double turns, deferred;
  br_mode_stats modes[MAX_MODES];
} g_stats;

static int mode_index(CFStringRef mode) {
  if (!mode) return -1;
  for (int i = 0; i < g_mode_count; i++) {
    if (g_modes[i] == mode || CFEqual(g_modes[i], mode)) return i;
  }
  if (g_mode_count == MAX_MODES) return -1;
  int i = g_mode_count++;
  g_modes[i] = CFRetain(mode);
  char buf[256];
  if (!CFStringGetCString(mode, buf, sizeof buf, kCFStringEncodingUTF8)) strcpy(buf, "?");
  g_mode_names[i] = strdup(buf);
  return i;
}

const char* br_main_mode_name(int32_t index) {
  return index >= 0 && index < g_mode_count ? g_mode_names[index] : "";
}

// A hold that ended: a stall if it was long enough (§8). Origin 0: event dispatch, 1: JavaScript.
typedef struct {
  double durationMs;
  int32_t mode;
  int32_t origin;
  double endedAt;  // br_now(), seconds
} br_stall;

#define RING 64
static br_stall g_stalls[RING];
static int g_stall_count;

static void record_stall(double ms, int mode, int origin) {
  double threshold = g_br_main.stallMs;
  if (!(threshold > 0) || ms < threshold) return;
  if (g_stall_count == RING) memmove(g_stalls, g_stalls + 1, sizeof(br_stall) * (RING - 1)), g_stall_count--;
  g_stalls[g_stall_count++] = (br_stall){ms, mode, origin, br_now()};
  atomic_fetch_or(&g_br_main.pending, BR_PENDING_STALLS);
}

static void record_nested(double ms, int mode, int fromJs) {
  g_stats.nestedCount += 1;
  g_stats.nestedTotalMs += ms;
  if (ms > g_stats.nestedLongestMs) g_stats.nestedLongestMs = ms;
  if (fromJs) g_stats.nestedFromJs += 1;
  if (mode >= 0) {
    br_mode_stats* m = &g_stats.modes[mode];
    m->count += 1;
    m->totalMs += ms;
    if (ms > m->longestMs) m->longestMs = ms;
  }
}

// Layout, all doubles: nested count, total ms, longest ms, from JavaScript, the longest pump
// (Bun's longest wait), turns, turns deferred off a safe point, the number of modes M, then
// M × (count, total ms, longest ms).
void br_main_stats(double* out, int32_t cap) {
  double head[] = {g_stats.nestedCount, g_stats.nestedTotalMs, g_stats.nestedLongestMs,
                   g_stats.nestedFromJs, g_stats.pumpLongestMs, g_stats.turns,
                   g_stats.deferred, (double)g_mode_count};
  int n = 0;
  for (int i = 0; i < 8 && n < cap; i++) out[n++] = head[i];
  for (int i = 0; i < g_mode_count; i++) {
    if (n + 3 > cap) break;
    out[n++] = g_stats.modes[i].count;
    out[n++] = g_stats.modes[i].totalMs;
    out[n++] = g_stats.modes[i].longestMs;
  }
}

void br_main_stats_reset(void) {
  memset(&g_stats, 0, sizeof g_stats);
}

int32_t br_main_take_stalls(void* out, int32_t cap) {
  int n = g_stall_count < cap ? g_stall_count : cap;
  memcpy(out, g_stalls, sizeof(br_stall) * (size_t)n);
  memmove(g_stalls, g_stalls + n, sizeof(br_stall) * (size_t)(g_stall_count - n));
  g_stall_count -= n;
  return n;
}

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

static void deadline_fired(CFRunLoopTimerRef timer, void* info);

// A new one-shot timer for every deadline, not one timer moved with CFRunLoopTimerSetNextFireDate.
// Measured: moved from inside its own callout — the turn it fires runs there — a timer in the
// common modes is re-armed only in the mode the callout ran in. Fired inside a live resize's
// tracking loop and moved there, it never fired again in the default mode, its date passed, until
// some other timer re-armed that mode: 4 s with nothing of the main loop's running. A timer that
// is added to the run loop is armed in every mode it is in.
static void arm_deadline(void) {
  if (!g_rl) return;
  double due = g_br_main.nextDue;
  double delay = g_br_main.nextDelay;
  if (delay < 0) {
    if (g_armed_due < 0) return;
  } else if (due == g_armed_due && g_deadline && CFRunLoopTimerIsValid(g_deadline)) {
    return;
  }
  if (g_deadline) {
    CFRunLoopTimerInvalidate(g_deadline);
    CFRelease(g_deadline);
    g_deadline = NULL;
  }
  g_armed_due = delay < 0 ? -1 : due;
  if (delay < 0) return;
  g_deadline = CFRunLoopTimerCreate(NULL, CFAbsoluteTimeGetCurrent() + delay, 0, 0, 0,
                                    deadline_fired, NULL);
  CFRunLoopAddTimer(g_rl, g_deadline, kCFRunLoopCommonModes);
}

static void run_turn(void) {
  atomic_store(&g_br_main.pendingTurn, 0);
  if (!g_turn) return;
  g_stats.turns += 1;
  atomic_fetch_add(&g_br_main.callbackDepth, 1);
  atomic_store(&g_br_main.inTurn, 1);
  @autoreleasepool {
    @try {
      g_turn();
    } @catch (NSException* e) {
      NSLog(@"[bunkit] exception escaping a main-loop turn: %@: %@", [e name], [e reason]);
    }
  }
  atomic_store(&g_br_main.inTurn, 0);
  atomic_fetch_sub(&g_br_main.callbackDepth, 1);
  arm_deadline();
}

// The source, the deadline timer or a clock fired: a turn now, or at the next safe point.
static void finish_unsafe(void);

static void fire(void) {
  if (br_main_is_safe()) {
    finish_unsafe();
    run_turn();
  } else if (!atomic_exchange(&g_br_main.pendingTurn, 1)) {
    g_stats.deferred += 1;
  }
}

static void wake_bun(void) {
  if (!atomic_load(&g_br_main.bunIdle)) return;
  if (atomic_exchange(&g_br_main.bunWake, 1)) return;
  pthread_mutex_lock(&g_wake_lock);
  if (g_wake) g_wake();
  pthread_mutex_unlock(&g_wake_lock);
}

void br_main_signal(void) {
  CFRunLoopSourceRef s = g_source;
  if (!s) return;
  atomic_store(&g_br_main.signalled, 1);
  CFRunLoopSourceSignal(s);
  CFRunLoopWakeUp(g_rl);
  // run() may be asleep in Bun rather than in the pump: end that sleep, so the pump comes round
  // now rather than at the end of it.
  wake_bun();
}

void br_main_arm(double delaySeconds) {
  g_br_main.nextDelay = delaySeconds;
  arm_deadline();
}

// ---------------------------------------------------------------------------
// Trampolined calls (§6.1)
// ---------------------------------------------------------------------------
//
// A call that would start a nested run loop is not made from JavaScript. JavaScript posts it,
// and the pump makes it from its own body, where nothing of JavaScript is on the stack: a nested
// loop "from event dispatch", inside which the main loop keeps running. The arguments are copied
// and every object among them retained until the call returns; the result comes back in the next
// turn.

typedef struct br_item {
  uint32_t token;
  void* target;
  void* sel;
  br_sig* sig;
  uint8_t* args;
  struct br_item* next;
} br_item;

typedef struct {
  uint32_t token;
  int32_t rc;
  int32_t retKind;
  int32_t _pad;
  uint8_t ret[32];
} br_completion;

static br_item* g_items;
static br_item** g_items_tail = &g_items;
static br_completion g_done[RING];
static int g_done_count;
static uint32_t g_next_token = 1;

static int is_object_kind(int32_t kind) { return kind == BR_K_OBJECT || kind == BR_K_BLOCK; }

uint32_t br_main_post_send(void* target, void* sel, const char* types, const void* argbuf,
                           int32_t argSize) {
  br_sig* s = br_sig_get(types);
  if (!s || !target || !sel) return 0;
  br_item* item = calloc(1, sizeof(br_item));
  item->args = calloc(1, (size_t)(s->argbuf_size > 0 ? s->argbuf_size : 1));
  if (argbuf && argSize > 0) {
    memcpy(item->args, argbuf, (size_t)(argSize < s->argbuf_size ? argSize : s->argbuf_size));
  }
  item->token = g_next_token++;
  if (g_next_token == 0) g_next_token = 1;
  item->target = target;
  item->sel = sel;
  item->sig = s;
  [(id)target retain];
  for (int32_t i = 2; i < s->nargs; i++) {
    if (!is_object_kind(s->args[i].kind)) continue;
    id o = *(id*)(item->args + s->args[i].offset);
    if (o) [o retain];
  }
  *g_items_tail = item;
  g_items_tail = &item->next;
  // A pump asleep in AppKit returns now and makes the call; one not running makes it first thing.
  br_wake_pump();
  return item->token;
}

static void run_items(void) {
  while (g_items && br_main_is_safe()) {
    br_item* item = g_items;
    g_items = item->next;
    if (!g_items) g_items_tail = &g_items;
    br_sig* s = item->sig;
    size_t retSize = (size_t)(s->retbuf_size > 32 ? s->retbuf_size : 32);
    uint8_t* ret = calloc(1, retSize);
    char* err = NULL;
    br_main_dispatch_begin();
    int rc = br_msgsend(item->target, item->sel, s->encoding, item->args, ret, &err);
    br_main_dispatch_end();
    if (err) {
      NSLog(@"[bunkit] a trampolined %s failed: %s", sel_getName((SEL)item->sel), err);
      free(err);
    }
    if (rc == BR_OK && is_object_kind(s->ret.kind)) {
      id o = *(id*)ret;
      if (o) [o retain];  // +1 for JavaScript
    }
    for (int32_t i = 2; i < s->nargs; i++) {
      if (!is_object_kind(s->args[i].kind)) continue;
      id o = *(id*)(item->args + s->args[i].offset);
      if (o) [o release];
    }
    [(id)item->target release];
    if (g_done_count < RING) {
      br_completion* c = &g_done[g_done_count++];
      c->token = item->token;
      c->rc = rc;
      c->retKind = s->ret.kind;
      memcpy(c->ret, ret, 32);
    } else {
      NSLog(@"[bunkit] too many trampolined calls finished without a turn; dropping one");
    }
    free(ret);
    free(item->args);
    free(item);
    atomic_fetch_or(&g_br_main.pending, BR_PENDING_COMPLETIONS);
    br_main_signal();
  }
}

int32_t br_main_take_completions(void* out, int32_t cap) {
  int n = g_done_count < cap ? g_done_count : cap;
  memcpy(out, g_done, sizeof(br_completion) * (size_t)n);
  memmove(g_done, g_done + n, sizeof(br_completion) * (size_t)(g_done_count - n));
  g_done_count -= n;
  return n;
}

// ---------------------------------------------------------------------------
// Nesting (§6.2, §8)
// ---------------------------------------------------------------------------
//
// One entry per run-loop run in progress. The pump's own wait in nextEventMatchingMask is not a
// nested loop. A run entered at a safe point is one AppKit entered from event dispatch (or from a
// trampolined call); it is measured per -sendEvent:, which is one menu, one resize, one drag. A
// run entered anywhere else has JavaScript on the stack: it is measured from the outermost such
// entry to its exit, and reported.

typedef struct {
  double start;
  int mode;
  // 0 the pump's own wait; 1 from event dispatch, measured with its -sendEvent:; 2 with
  // JavaScript on the stack; 3 at a safe point outside any dispatch, measured on its own
  int kind;
} br_entry;

#define MAX_DEPTH 64
static br_entry g_entries[MAX_DEPTH];
static int g_entry_depth;
// The pump is waiting in nextEventMatchingMask, which may run the loop more than once: every
// entry at the depth it waits at is its own.
static int g_pump_waiting;
static int g_pump_wait_depth;
// A hold with JavaScript on the stack: from its first entry to the last exit before the main
// thread next reaches a safe point. One JavaScript call that runs the loop over and over —
// -runMode:beforeDate: in a loop — is one hold, not one per run.
static int g_unsafe_open;
static int g_unsafe_pending;  // exited, and no safe point since: the next entry continues it
static double g_unsafe_start;
static double g_unsafe_last_exit;
static int g_unsafe_mode;
static uint32_t g_unsafe_seq;
static uint32_t g_next_seq = 1;

// The -sendEvent: (or trampolined call) in progress, and the nested loop it ran, if any.
static int g_dispatch_depth;
static double g_dispatch_start;
static int g_dispatch_nested;
static int g_dispatch_mode = -1;

typedef struct {
  uint32_t seq;
  int32_t mode;
  double durationMs;
  double endedAt;
} br_nested;

static br_nested g_nested[RING];
static int g_nested_count;

// A safe point: a hold with JavaScript on the stack that has exited is over. Reported now.
static void finish_unsafe(void) {
  if (!g_unsafe_pending || g_unsafe_open) return;
  g_unsafe_pending = 0;
  double ms = (g_unsafe_last_exit - g_unsafe_start) * 1000;
  record_nested(ms, g_unsafe_mode, 1);
  record_stall(ms, g_unsafe_mode, 1);
  if (g_nested_count < RING) {
    g_nested[g_nested_count++] = (br_nested){g_unsafe_seq, g_unsafe_mode, ms, g_unsafe_last_exit};
    atomic_fetch_or(&g_br_main.pending, BR_PENDING_NESTED);
  }
}

int32_t br_main_take_nested(void* out, int32_t cap) {
  int n = g_nested_count < cap ? g_nested_count : cap;
  memcpy(out, g_nested, sizeof(br_nested) * (size_t)n);
  memmove(g_nested, g_nested + n, sizeof(br_nested) * (size_t)(g_nested_count - n));
  g_nested_count -= n;
  return n;
}

int br_main_pump_wait_begin(void) {
  int previous = g_pump_waiting ? g_pump_wait_depth : -1;
  g_pump_waiting = 1;
  g_pump_wait_depth = g_entry_depth;
  return previous;
}

void br_main_pump_wait_end(int previous) {
  g_pump_waiting = previous >= 0;
  g_pump_wait_depth = previous >= 0 ? previous : 0;
}

void br_main_dispatch_begin(void) {
  if (g_dispatch_depth++ == 0) {
    g_dispatch_start = br_now();
    g_dispatch_nested = 0;
    g_dispatch_mode = -1;
  }
}

void br_main_dispatch_end(void) {
  if (--g_dispatch_depth != 0) return;
  double ms = (br_now() - g_dispatch_start) * 1000;
  if (g_dispatch_nested) record_nested(ms, g_dispatch_mode, 0);
  record_stall(ms, g_dispatch_mode, 0);
}

void br_main_pump_end(double seconds) {
  double ms = seconds * 1000;
  if (ms > g_stats.pumpLongestMs) g_stats.pumpLongestMs = ms;
}

static void observe(CFRunLoopObserverRef observer, CFRunLoopActivity activity, void* info) {
  if (activity == kCFRunLoopEntry) {
    atomic_fetch_add(&g_br_main.nesting, 1);
    br_entry e = {0, -1, 0};
    if (g_pump_waiting && g_entry_depth == g_pump_wait_depth) {
      // The pump's own wait, many times a second: nothing to measure, so nothing looked up.
      finish_unsafe();
      if (g_entry_depth < MAX_DEPTH) g_entries[g_entry_depth] = e;
      g_entry_depth++;
      return;
    }
    e.start = br_now();
    CFStringRef mode = CFRunLoopCopyCurrentMode(g_rl);
    e.mode = mode_index(mode);
    if (mode) CFRelease(mode);
    if (br_main_is_safe()) {
      finish_unsafe();
      if (g_dispatch_depth > 0) {
        e.kind = 1;
        if (!g_dispatch_nested) g_dispatch_mode = e.mode;
        g_dispatch_nested = 1;
      } else {
        e.kind = 3;
      }
    } else {
      e.kind = 2;
      if (g_unsafe_open++ == 0 && !g_unsafe_pending) {
        g_unsafe_start = e.start;
        g_unsafe_mode = e.mode;
        g_unsafe_seq = g_next_seq++;
        // Development builds ask JavaScript for its stack: side-effect free, and the one call
        // into JavaScript made off a safe point (§6.2).
        if (g_stack) {
          atomic_fetch_add(&g_br_main.callbackDepth, 1);
          g_stack(g_unsafe_seq);
          atomic_fetch_sub(&g_br_main.callbackDepth, 1);
        }
      }
    }
    if (g_entry_depth < MAX_DEPTH) g_entries[g_entry_depth] = e;
    g_entry_depth++;
  } else if (activity == kCFRunLoopExit) {
    atomic_fetch_sub(&g_br_main.nesting, 1);
    if (g_entry_depth == 0) return;
    g_entry_depth--;
    if (g_entry_depth >= MAX_DEPTH) return;
    br_entry e = g_entries[g_entry_depth];
    if (e.kind == 3) {
      double ms = (br_now() - e.start) * 1000;
      record_nested(ms, e.mode, 0);
      record_stall(ms, e.mode, 0);
    } else if (e.kind == 2 && --g_unsafe_open == 0) {
      g_unsafe_pending = 1;
      g_unsafe_last_exit = br_now();
    }
  }
}

// ---------------------------------------------------------------------------
// The pump's hooks (runloop.m)
// ---------------------------------------------------------------------------

void br_main_run_pending(void) {
  if (!br_main_is_safe()) return;
  finish_unsafe();
  run_items();
  if (atomic_load(&g_br_main.pendingTurn) && br_main_is_safe()) run_turn();
}

// ---------------------------------------------------------------------------
// Frame clocks (§5)
// ---------------------------------------------------------------------------
//
// One per screen, so every frame callback of one screen runs in one turn, paced by that screen:
// a window on a 60 Hz display draws at 60, on a ProMotion panel at up to 120. NSScreen's display
// link (macOS 14+), in the common modes; on older systems a common-modes run-loop timer at the
// screen's refresh interval stands in.

@interface BRFrameClock : NSObject {
 @public
  int slot;
  CADisplayLink* link;
  CFRunLoopTimerRef timer;
  double interval;
}
- (void)tick:(CADisplayLink*)link;
@end

static BRFrameClock* g_clock_objects[BR_MAX_CLOCKS];

static void clock_fired(int slot, double timestamp, double target) {
  br_clock_slot* s = &g_br_clocks[slot];
  if (atomic_load(&s->due)) s->missed += 1;
  s->timestamp = timestamp;
  s->targetTimestamp = target;
  s->duration = target - timestamp;
  s->fired += 1;
  atomic_store(&s->due, 1);
  atomic_fetch_or(&g_br_main.pending, BR_PENDING_FRAMES);
  fire();
}

@implementation BRFrameClock
- (void)tick:(CADisplayLink*)l {
  clock_fired(slot, [l timestamp], [l targetTimestamp]);
}
@end

static void clock_timer_fired(CFRunLoopTimerRef timer, void* info) {
  BRFrameClock* c = (BRFrameClock*)info;
  double t = CACurrentMediaTime();
  clock_fired(c->slot, t, t + c->interval);
}

static uint32_t display_of_screen(NSScreen* screen) {
  if (!screen) return 0;
  NSNumber* n = [[screen deviceDescription] objectForKey:@"NSScreenNumber"];
  return n ? [n unsignedIntValue] : 0;
}

static NSScreen* screen_for_display(uint32_t displayID) {
  for (NSScreen* s in [NSScreen screens]) {
    if (display_of_screen(s) == displayID) return s;
  }
  return nil;
}

uint32_t br_main_main_display(void) {
  @autoreleasepool {
    NSScreen* s = [NSScreen mainScreen];
    if (!s) s = [[NSScreen screens] firstObject];
    return display_of_screen(s);
  }
}

uint32_t br_main_display_of(void* view) {
  if (!view) return 0;
  @autoreleasepool {
    return display_of_screen([[(NSView*)view window] screen]);
  }
}

static void clock_close(int slot) {
  BRFrameClock* c = g_clock_objects[slot];
  if (c) {
    if (c->link) [c->link invalidate];
    if (c->timer) {
      CFRunLoopTimerInvalidate(c->timer);
      CFRelease(c->timer);
    }
    [c release];
    g_clock_objects[slot] = nil;
  }
  br_clock_slot* s = &g_br_clocks[slot];
  if (s->running) atomic_fetch_sub(&g_br_main.clocksRunning, 1);
  memset(s, 0, sizeof *s);
}

int br_main_clock_open(uint32_t displayID) {
  if (displayID == 0) displayID = br_main_main_display();
  if (displayID == 0) return -1;
  for (int i = 0; i < BR_MAX_CLOCKS; i++) {
    if (g_br_clocks[i].displayID == displayID) return i;
  }
  int slot = -1;
  for (int i = 0; i < BR_MAX_CLOCKS; i++) {
    if (g_br_clocks[i].displayID == 0) {
      slot = i;
      break;
    }
  }
  if (slot < 0) return -1;
  @autoreleasepool {
    NSScreen* screen = screen_for_display(displayID);
    if (!screen) return -1;
    BRFrameClock* c = [[BRFrameClock alloc] init];
    c->slot = slot;
    br_clock_slot* s = &g_br_clocks[slot];
    memset(s, 0, sizeof *s);
    s->displayID = displayID;
    if ([screen respondsToSelector:@selector(displayLinkWithTarget:selector:)]) {
      c->link = [[screen displayLinkWithTarget:c selector:@selector(tick:)] retain];
      [c->link setPaused:YES];
      [c->link addToRunLoop:[NSRunLoop mainRunLoop] forMode:NSRunLoopCommonModes];
    } else {
      NSInteger fps = [screen respondsToSelector:@selector(maximumFramesPerSecond)]
                          ? [screen maximumFramesPerSecond] : 60;
      c->interval = 1.0 / (double)(fps > 0 ? fps : 60);
      s->fallback = 1;  // its timer is made when it starts
    }
    g_clock_objects[slot] = c;
  }
  return slot;
}

void br_main_clock_run(int slot, int on) {
  if (slot < 0 || slot >= BR_MAX_CLOCKS) return;
  BRFrameClock* c = g_clock_objects[slot];
  br_clock_slot* s = &g_br_clocks[slot];
  if (!c || (s->running != 0) == (on != 0)) return;
  s->running = on ? 1 : 0;
  if (on) atomic_fetch_add(&g_br_main.clocksRunning, 1);
  else atomic_fetch_sub(&g_br_main.clocksRunning, 1);
  if (!on) atomic_store(&s->due, 0);
  if (c->link) [c->link setPaused:on ? NO : YES];
  if (s->fallback) {
    // Made anew each start, never moved: see arm_deadline.
    if (c->timer) {
      CFRunLoopTimerInvalidate(c->timer);
      CFRelease(c->timer);
      c->timer = NULL;
    }
    if (on) {
      CFRunLoopTimerContext ctx = {0, c, NULL, NULL, NULL};
      c->timer = CFRunLoopTimerCreate(NULL, CFAbsoluteTimeGetCurrent() + c->interval, c->interval,
                                      0, 0, clock_timer_fired, &ctx);
      CFRunLoopAddTimer(g_rl, c->timer, kCFRunLoopCommonModes);
    }
  }
}

// Screens came, went or changed, or a window moved to another one: close the clocks of screens
// that are gone, and tell JavaScript to look again at which screen each of its views is on.
static void screens_changed(void) {
  @autoreleasepool {
    for (int i = 0; i < BR_MAX_CLOCKS; i++) {
      uint32_t id = g_br_clocks[i].displayID;
      if (id && !screen_for_display(id)) clock_close(i);
    }
  }
  atomic_fetch_add(&g_br_main.screens, 1);
  br_main_signal();
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

static void source_perform(void* info) {
  atomic_store(&g_br_main.signalled, 0);
  fire();
}
static void deadline_fired(CFRunLoopTimerRef timer, void* info) {
  g_armed_due = -1;
  fire();
}

void br_main_init(void* turn, void* stack, void* wake) {
  g_turn = (br_turn_fn)turn;
  g_stack = (br_stack_fn)stack;
  pthread_mutex_lock(&g_wake_lock);
  g_wake = (br_wake_fn)wake;
  pthread_mutex_unlock(&g_wake_lock);
  if (g_source) return;
  g_rl = CFRunLoopGetMain();
  CFRunLoopSourceContext ctx = {0};
  ctx.perform = source_perform;
  g_source = CFRunLoopSourceCreate(NULL, 0, &ctx);
  CFRunLoopAddSource(g_rl, g_source, kCFRunLoopCommonModes);
  // First in, last out, so it brackets everything else on the run loop. In the modes AppKit's
  // nested loops run in — tracking (menus, live resize, drags) and modal panels — and not the
  // default mode, which the pump itself waits in many times a second: observed there, the two
  // callouts a wait made cost every pump an eighth more than v1's (§11, test 8).
  CFRunLoopObserverRef observer = CFRunLoopObserverCreate(
      NULL, kCFRunLoopEntry | kCFRunLoopExit, true, LONG_MIN, observe, NULL);
  CFRunLoopAddObserver(g_rl, observer, (CFStringRef)NSEventTrackingRunLoopMode);
  CFRunLoopAddObserver(g_rl, observer, (CFStringRef)NSModalPanelRunLoopMode);
  NSNotificationCenter* nc = [NSNotificationCenter defaultCenter];
  for (NSString* name in @[NSApplicationDidChangeScreenParametersNotification,
                           NSWindowDidChangeScreenNotification]) {
    [nc addObserverForName:name object:nil queue:nil usingBlock:^(NSNotification* n) {
      screens_changed();
    }];
  }
  g_br_main.nextDelay = -1;
}

// After this, no thread calls into a JavaScript VM that is going away.
void br_main_shutdown(void) {
  pthread_mutex_lock(&g_wake_lock);
  g_wake = NULL;
  pthread_mutex_unlock(&g_wake_lock);
  g_turn = NULL;
  g_stack = NULL;
}

