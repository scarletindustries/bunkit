// closures.m — runtime Obj-C classes whose methods are libffi closures that
// re-enter JavaScript, plus synthesised Obj-C blocks over the same machinery.

#import <Foundation/Foundation.h>
#include <objc/runtime.h>
#include <objc/message.h>
#include <string.h>
#include <stdlib.h>
#include <alloca.h>
#include <stdatomic.h>
#include "bridge.h"

// The single fixed-signature entry point back into JS. Bun declares this as
//   { args: [u32, u32, ptr, ptr], returns: void }
typedef void (*br_js_fn)(uint32_t methodToken, uint32_t instanceToken,
                         void* argbuf, void* retbuf);

typedef struct {
  br_sig*   sig;
  br_js_fn  jsfn;
  uint32_t  token;
  size_t    retzero;   // bytes of `ret` the closure must initialise
  int       isBlock;
  ffi_closure* closure;
  void*     code;
} br_ctx;

// Associated-object key for the per-instance token.
static const void* kTokenKey = &kTokenKey;

void br_object_set_token(void* obj, uint32_t token) {
  if (!obj) return;
  objc_setAssociatedObject((__bridge id)obj, kTokenKey,
                           [NSNumber numberWithUnsignedInt:token],
                           OBJC_ASSOCIATION_RETAIN_NONATOMIC);
}

uint32_t br_object_get_token(void* obj) {
  if (!obj) return 0;
  NSNumber* n = objc_getAssociatedObject((__bridge id)obj, kTokenKey);
  return n ? [n unsignedIntValue] : 0;
}

// ---------------------------------------------------------------------------
// The trampoline
// ---------------------------------------------------------------------------

static void br_trampoline(ffi_cif* cif, void* ret, void** args, void* user) {
  (void)cif;
  br_ctx* ctx = (br_ctx*)user;
  br_sig* s = ctx->sig;

  // Pack the incoming arguments into the same flat layout JS uses for msgSend,
  // so both directions share one decoder.
  void* argbuf = alloca((size_t)s->argbuf_size);
  memset(argbuf, 0, (size_t)s->argbuf_size);
  for (int32_t i = 0; i < s->nargs; i++) {
    if (s->args[i].size > 0)
      memcpy((char*)argbuf + s->args[i].offset, args[i], (size_t)s->args[i].size);
  }

  // libffi guarantees `ret` is at least sizeof(ffi_arg); widen small integer
  // returns to that so stale bytes can never leak into the caller's register.
  if (ctx->retzero) memset(ret, 0, ctx->retzero);

  uint32_t inst = 0;
  if (!ctx->isBlock && s->nargs >= 1 && s->args[0].size == 8) {
    void* self_ = *(void**)((char*)argbuf + s->args[0].offset);
    inst = br_object_get_token(self_);
  }

  // Counted, so the main loop never starts a turn while this is on the stack
  // (docs/main-loop/spec.md §3). A plain add on a word JavaScript reads directly.
  atomic_fetch_add_explicit(&g_br_main.callbackDepth, 1, memory_order_relaxed);
  @try {
    ctx->jsfn(ctx->token, inst, argbuf, ret);
  } @catch (NSException* e) {
    NSLog(@"[objcbridge] exception escaping JS callback: %@", e);
  }
  atomic_fetch_sub_explicit(&g_br_main.callbackDepth, 1, memory_order_relaxed);
}

static br_ctx* make_closure(const char* types, void* jsfn, uint32_t token, int isBlock) {
  br_sig* s = br_sig_get(types);
  if (!s) return NULL;
  br_ctx* ctx = (br_ctx*)calloc(1, sizeof(br_ctx));
  ctx->sig = s;
  ctx->jsfn = (br_js_fn)jsfn;
  ctx->token = token;
  ctx->isBlock = isBlock;
  // How much of libffi's return buffer we are allowed to touch.
  //
  // For scalar returns narrower than ffi_arg, libffi requires the closure to
  // write a full ffi_arg — otherwise the upper bytes of the return register are
  // whatever was there before. For aggregates the buffer is exactly the
  // struct's size, so widening would scribble past the end.
  int aggregate = s->ret.kind == BR_K_STRUCT || s->ret.kind == BR_K_UNION ||
                  s->ret.kind == BR_K_ARRAY;
  if (s->ret.size == 0) ctx->retzero = 0;
  else if (aggregate) ctx->retzero = (size_t)s->ret.size;
  else ctx->retzero = (size_t)s->ret.size > sizeof(ffi_arg) ? (size_t)s->ret.size
                                                            : sizeof(ffi_arg);
  void* code = NULL;
  ffi_closure* cl = ffi_closure_alloc(sizeof(ffi_closure), &code);
  if (!cl) { free(ctx); return NULL; }
  if (ffi_prep_closure_loc(cl, &s->cif, br_trampoline, ctx, code) != FFI_OK) {
    ffi_closure_free(cl); free(ctx); return NULL;
  }
  ctx->closure = cl;
  ctx->code = code;
  return ctx;
}

// ---------------------------------------------------------------------------
// Runtime classes
// ---------------------------------------------------------------------------

void* br_class_create(const char* name, const char* superclass) {
  Class super = objc_lookUpClass(superclass ? superclass : "NSObject");
  if (!super) return NULL;
  if (objc_lookUpClass(name)) return NULL;  // caller must pick a fresh name
  return (void*)objc_allocateClassPair(super, name, 0);
}

int br_class_add_method(void* cls, void* sel, const char* types,
                        void* js_callback, uint32_t token, int classMethod) {
  if (!cls || !sel || !types || !js_callback) return BR_ERR_NIL_TARGET;
  br_ctx* ctx = make_closure(types, js_callback, token, 0);
  if (!ctx) return BR_ERR_BAD_ENCODING;
  Class target = classMethod ? object_getClass((id)cls) : (Class)cls;
  BOOL ok = class_addMethod(target, (SEL)sel, (IMP)ctx->code, types);
  if (!ok) {
    // Already present (e.g. inherited and overridden twice) — replace instead.
    class_replaceMethod(target, (SEL)sel, (IMP)ctx->code, types);
  }
  return BR_OK;
}

int br_class_add_protocol(void* cls, const char* protoName) {
  Protocol* p = objc_getProtocol(protoName);
  if (!p || !cls) return BR_ERR_NO_METHOD;
  return class_addProtocol((Class)cls, p) ? BR_OK : BR_ERR_NO_METHOD;
}

int br_class_add_ivar_ptr(void* cls, const char* name) {
  if (!cls) return BR_ERR_NIL_TARGET;
  return class_addIvar((Class)cls, name, sizeof(void*),
                       (uint8_t)__builtin_ctz(sizeof(void*)), "^v")
             ? BR_OK : BR_ERR_ALLOC;
}

void br_class_register(void* cls) {
  if (cls) objc_registerClassPair((Class)cls);
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

enum {
  BR_BLOCK_HAS_COPY_DISPOSE = (1 << 25),
  BR_BLOCK_HAS_SIGNATURE    = (1 << 30),
};

struct BRBlockDescriptor {
  unsigned long reserved;
  unsigned long size;
  const char*   signature;
};

struct BRBlock {
  void* isa;
  int   flags;
  int   reserved;
  void  (*invoke)(void*, ...);
  struct BRBlockDescriptor* descriptor;
  br_ctx* ctx;   // captured; keeps the closure reachable for br_block_release
};

extern void* _NSConcreteGlobalBlock[32];

void* br_block_create(const char* types, void* js_callback, uint32_t token) {
  if (!types || !js_callback) return NULL;
  br_ctx* ctx = make_closure(types, js_callback, token, 1);
  if (!ctx) return NULL;

  struct BRBlockDescriptor* d =
      (struct BRBlockDescriptor*)calloc(1, sizeof(struct BRBlockDescriptor));
  d->reserved = 0;
  d->size = sizeof(struct BRBlock);
  d->signature = strdup(types);

  struct BRBlock* b = (struct BRBlock*)calloc(1, sizeof(struct BRBlock));
  // A *global* block is never copied or freed by the runtime, so AppKit holding
  // on to it can never leave us with a dangling closure. We free it explicitly.
  b->isa = (void*)&_NSConcreteGlobalBlock;
  b->flags = BR_BLOCK_HAS_SIGNATURE;
  b->reserved = 0;
  b->invoke = (void (*)(void*, ...))ctx->code;
  b->descriptor = d;
  b->ctx = ctx;
  return b;
}

void br_block_release(void* block) {
  if (!block) return;
  struct BRBlock* b = (struct BRBlock*)block;
  if (b->ctx) {
    if (b->ctx->closure) ffi_closure_free(b->ctx->closure);
    free(b->ctx);
  }
  if (b->descriptor) {
    free((void*)b->descriptor->signature);
    free(b->descriptor);
  }
  free(b);
}
