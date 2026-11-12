// bridge.h — shared internals for libobjcbridge
//
// The entire exported C surface is declared here. It is intentionally small and
// permanently stable: adding support for a new AppKit class must never require a
// change to this file.
//
// arm64 only. That is a simplification, not an omission: on arm64 every struct
// return goes through plain objc_msgSend with x8 as the indirect result
// register, so none of the objc_msgSend_stret / _fpret variants that x86_64
// needs exist here at all.
#ifndef BR_BRIDGE_H
#define BR_BRIDGE_H

#include <ffi/ffi.h>
#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

// ---------------------------------------------------------------------------
// Result codes
// ---------------------------------------------------------------------------
enum {
  BR_OK = 0,
  BR_ERR_BAD_ENCODING = -1,
  BR_ERR_EXCEPTION = -2,
  BR_ERR_NO_METHOD = -3,
  BR_ERR_NIL_TARGET = -4,
  BR_ERR_ALLOC = -5,
  BR_ERR_OVERFLOW = -6,
};

// ---------------------------------------------------------------------------
// Type kinds handed to JS. Stable numeric values — JS mirrors this enum.
// ---------------------------------------------------------------------------
enum {
  BR_K_VOID = 0,
  BR_K_SINT8,
  BR_K_UINT8,
  BR_K_SINT16,
  BR_K_UINT16,
  BR_K_SINT32,
  BR_K_UINT32,
  BR_K_SINT64,
  BR_K_UINT64,
  BR_K_FLOAT,
  BR_K_DOUBLE,
  BR_K_BOOL,
  BR_K_OBJECT,   // @
  BR_K_CLASS,    // #
  BR_K_SEL,      // :
  BR_K_CHARPTR,  // *
  BR_K_POINTER,  // ^type
  BR_K_STRUCT,   // {...}
  BR_K_UNION,    // (...)
  BR_K_ARRAY,    // [Nt]
  BR_K_BLOCK,    // @?
  BR_K_UNKNOWN,
};

// Per-argument layout descriptor shipped to JS.
typedef struct {
  int32_t kind;
  int32_t size;
  int32_t align;
  int32_t offset;  // byte offset into the packed argbuf
} br_arg;

// A parsed method signature: everything needed to make the call.
typedef struct br_sig {
  char*      encoding;     // owned copy, also the cache key
  ffi_cif    cif;
  ffi_type*  rtype;
  ffi_type** atypes;
  int32_t    nargs;
  br_arg     ret;
  br_arg*    args;
  int32_t    argbuf_size;
  int32_t    retbuf_size;
  struct br_sig* next;     // hash-bucket chain
} br_sig;

// Parse (and memoise) a full method type encoding, e.g. "v24@0:8@16".
// Returns NULL if the encoding cannot be represented.
br_sig* br_sig_get(const char* encoding);

// Parse a *bare* type encoding (a single type, no offsets) into an ffi_type.
// Returned ffi_type pointers are cached forever and must not be freed.
ffi_type* br_ffi_type_for(const char** cursor, br_arg* out);

// ---------------------------------------------------------------------------
// The exported ABI
// ---------------------------------------------------------------------------

// --- introspection ---------------------------------------------------------
const char* br_version(void);
void*       br_class(const char* name);
void*       br_metaclass(const char* name);
void*       br_selector(const char* name);
const char* br_selector_name(void* sel);
const char* br_method_signature(void* cls, void* sel, int instance);
const char* br_protocol_method_signature(const char* proto, void* sel,
                                         int required, int instance);
const char* br_object_class_name(void* obj);
void*       br_object_class(void* obj);
int         br_responds(void* obj, void* sel);
int         br_class_responds(void* cls, void* sel, int instance);
int         br_is_kind_of(void* obj, void* cls);
const char* br_class_super_name(void* cls);
int         br_copy_method_list(void* cls, int instance, char* out, int cap);
int         br_copy_class_list(char* out, int cap);
int         br_copy_protocol_method_list(const char* proto, char* out, int cap);

// Writes a flat int32 layout description for `types` into `out`.
// Layout: [nargs, argbufSize, retbufSize, retKind, retSize, retAlign,
//          (kind,size,align,offset) * nargs]
// Returns number of int32s written, or a negative BR_ERR_*.
int32_t br_signature_layout(const char* types, int32_t* out, int32_t cap);

// Same, for a bare (single) type encoding: [kind, size, align].
int32_t br_type_layout(const char* type, int32_t* out, int32_t cap);

// --- dispatch --------------------------------------------------------------
int br_msgsend(void* target, void* sel, const char* types,
               void* argbuf, void* retbuf, char** err);
int br_msgsend_super(void* target, void* superclass, void* sel, const char* types,
                     void* argbuf, void* retbuf, char** err);

// --- plain C functions (dlsym'd) -------------------------------------------
int br_call_function(void* fn, const char* types, void* argbuf, void* retbuf, char** err);

// --- runtime class creation ------------------------------------------------
void* br_class_create(const char* name, const char* superclass);
int   br_class_add_method(void* cls, void* sel, const char* types,
                          void* js_callback, uint32_t token, int classMethod);
int   br_class_add_protocol(void* cls, const char* protoName);
int   br_class_add_ivar_ptr(void* cls, const char* name);
void  br_class_register(void* cls);
void  br_object_set_token(void* obj, uint32_t token);
uint32_t br_object_get_token(void* obj);

// --- blocks ----------------------------------------------------------------
void* br_block_create(const char* types, void* js_callback, uint32_t token);
void  br_block_release(void* block);

// --- memory ----------------------------------------------------------------
void* br_retain(void* obj);
void  br_release(void* obj);
void  br_autorelease(void* obj);
long  br_retain_count(void* obj);
void  br_autorelease_pool_push(void);
void  br_autorelease_pool_pop(void);
int   br_autorelease_pool_recycle(void);
int   br_autorelease_pool_depth(void);
void  br_free(void* p);

// --- string fast paths -----------------------------------------------------
void*       br_nsstring(const char* utf8, int32_t len);
const char* br_nsstring_utf8(void* s);
int32_t     br_nsstring_len(void* s);

// --- symbols ---------------------------------------------------------------
void* br_dlsym(const char* name);

// --- app lifecycle & run loop ----------------------------------------------
void br_app_init(int activationPolicy);
int  br_pump(double seconds);
void br_stop(void);
int  br_should_stop(void);
void br_set_stop_callback(void* js_callback);
void br_post_empty_event(void);
void br_wake_pump(void); // from any thread: one empty event, unless one is already waiting
double br_now(void);

// --- the main loop (mainloop.m) — docs/main-loop/spec.md ------------------
//
// State both sides read: a static JavaScript views as a Uint32Array (the first 16 words) and a
// Float64Array (from byte 64), so keeping it costs no FFI call. src/mainloop.ts mirrors the
// indices. Words written off the main thread are atomic.
typedef struct br_main_state {
  _Atomic uint32_t callbackDepth;  // [0] native → JavaScript entries in progress
  _Atomic uint32_t inPump;         // [1] br_pump calls in progress
  _Atomic uint32_t inTurn;         // [2] a turn is running
  _Atomic uint32_t pendingTurn;    // [3] a turn came due off a safe point; br_pump runs it
  _Atomic uint32_t pending;        // [4] BR_PENDING_* bits: native work waiting for a turn
  _Atomic uint32_t bunIdle;        // [5] run() is idle-waiting in Bun (set by JavaScript)
  _Atomic uint32_t bunWake;        // [6] a wake-up of Bun's loop is outstanding
  _Atomic uint32_t screens;        // [7] bumped when screens change or a window changes screen
  _Atomic uint32_t nesting;        // [8] run-loop runs in progress on the main thread
  _Atomic uint32_t clocksRunning;  // [9] frame clocks running
  _Atomic uint32_t signalled;      // [10] the work source is signalled and has not run yet
  uint32_t _u32[5];                // [11..15]
  double nextDelay;                // f64 [8]  seconds to the main loop's next deadline, < 0 none (JS writes in a turn)
  double stallMs;                  // f64 [9]  report holds at least this long as stalls, 0 = none (JS writes)
  double nextDue;                  // f64 [10] that deadline in JavaScript's own clock: unchanged means armed
  double _f64[5];                  // f64 [11..15]
} br_main_state;

extern br_main_state g_br_main;

enum {
  BR_PENDING_FRAMES = 1,       // a frame clock fired
  BR_PENDING_COMPLETIONS = 2,  // a trampolined call finished
  BR_PENDING_NET = 4,          // net.m has events
  BR_PENDING_NESTED = 8,       // a nested loop started by JavaScript ended (§6.2)
  BR_PENDING_STALLS = 16,      // a hold past the stall threshold ended (§8)
};

// A frame clock: one display link per screen. JavaScript views the array of them.
#define BR_MAX_CLOCKS 16
typedef struct br_clock_slot {
  _Atomic uint32_t due;     // fired, and not yet delivered
  uint32_t displayID;       // CGDirectDisplayID, 0 for a free slot
  uint32_t running;
  uint32_t fallback;        // driven by a run-loop timer: no display link on this macOS
  double timestamp;         // CADisplayLink's: the frame's, the next one's, and the interval
  double targetTimestamp;
  double duration;
  double fired;             // callbacks from the display link
  double missed;            // fires that found the last one still undelivered
  double _pad;
} br_clock_slot;

void* br_main_state_ptr(void);
void* br_main_clocks_ptr(void);
void  br_main_init(void* turn, void* stack, void* wake);
void  br_main_shutdown(void);
void  br_main_signal(void);                 // from any thread
void  br_main_arm(double delaySeconds);     // main thread; < 0 disarms
int   br_main_clock_open(uint32_t displayID);
void  br_main_clock_run(int slot, int on);
uint32_t br_main_display_of(void* view);    // the display a view's window is on, 0 for none
uint32_t br_main_main_display(void);
// Trampolined calls (§6.1): a message sent from the pump, with no JavaScript on the stack.
uint32_t br_main_post_send(void* target, void* sel, const char* types, const void* argbuf,
                           int32_t argSize);
int32_t  br_main_take_completions(void* out, int32_t cap);
int32_t  br_main_take_nested(void* out, int32_t cap);
int32_t  br_main_take_stalls(void* out, int32_t cap);
const char* br_main_mode_name(int32_t index);
void     br_main_stats(double* out, int32_t cap);
void     br_main_stats_reset(void);
// Called by runloop.m.
int   br_main_is_safe(void);
void  br_main_run_pending(void);            // run a turn left pending, if at a safe point now
int   br_main_pump_wait_begin(void);       // returns what br_main_pump_wait_end restores
void  br_main_pump_wait_end(int previous);
void  br_main_dispatch_begin(void);
void  br_main_dispatch_end(void);
void  br_main_pump_end(double seconds);

// --- drawables, taken off the main thread (drawables.m) --------------------
void* br_drawables_create(void* layer);
void  br_drawables_arm(void* pump, int on);
int   br_drawables_ready(void* pump);
void* br_drawables_take(void* pump);
void  br_drawables_destroy(void* pump);

// --- libraries and pipelines, compiled on Metal's threads (compile.m) ------
// A job: poll it (0 compiling, 1 compiled, -1 failed), take the result (+1)
// and a pipeline's reflection (+1, or NULL), or read the error (valid until
// freed), and free it exactly once.
void*       br_library_compile(void* device, const char* source);
void*       br_render_pipeline_compile(void* device, void* descriptor, uint64_t options);
void*       br_compute_pipeline_compile(void* device, void* function, uint64_t options);
int         br_compile_poll(void* job);
void*       br_compile_take(void* job);
void*       br_compile_take_reflection(void* job);
const char* br_compile_error(void* job);
void        br_compile_free(void* job);

// --- MetalFX effects, built on a background queue (metalfx.m) -------------
// kind: 0 a temporal scaler, 1 a frame interpolator, 2 a spatial scaler. The
// descriptor is copied. Poll (0 building, 1 built, -1 failed), take the effect
// (+1), and free the job exactly once.
void* br_fx_create(void* device, void* descriptor, int kind);
int   br_fx_poll(void* job);
void* br_fx_take(void* job);
void  br_fx_free(void* job);

// --- peer-to-peer connections on Network.framework (net.m) ----------------
// Everything runs on one private serial queue; JavaScript takes what happened
// with br_net_poll (40-byte records, see net.m) after `notify` — a threadsafe
// callback — says there is something to take. Handles are reference counted:
// br_net_free drops JavaScript's reference exactly once per handle.
void     br_net_init(void* notify);
void     br_net_shutdown(void);
int32_t  br_net_poll(void* out, int32_t cap);
void     br_net_release_bytes(void* bytes, void* context);
uint32_t br_net_id(void* handle);
long     br_net_live(void);
void*    br_net_listen(const char* type, const char* name, const void* txt, int32_t txt_len,
                       int32_t peer_to_peer, const void* keys, int32_t keys_len,
                       uint32_t max_message, int32_t port);
void     br_net_listener_set_txt(void* listener, const void* txt, int32_t txt_len);
void*    br_net_browse(const char* type, int32_t peer_to_peer);
void*    br_net_connect(void* browser, const char* name, const char* type, const char* domain,
                        const char* host, int32_t port, int32_t peer_to_peer, const void* keys,
                        int32_t keys_len, uint32_t max_message);
int32_t  br_net_send(void* connection, const void* bytes, uint32_t length, uint64_t sequence);
void     br_net_close(void* handle);
void     br_net_free(void* handle);

#ifdef __cplusplus
}
#endif
#endif
