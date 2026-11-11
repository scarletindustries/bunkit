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
double br_now(void);

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

#ifdef __cplusplus
}
#endif
#endif
