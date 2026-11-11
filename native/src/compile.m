// compile.m — compile shader libraries and pipeline states on Metal's threads,
// not the caller's.
//
// -[MTLDevice newLibraryWithSource:options:error:] runs the whole MSL front end
// on the calling thread, and -newRenderPipelineStateWithDescriptor:… and
// -newComputePipelineStateWithFunction:… the back end that turns a function
// into GPU code. For what Metal's shader cache has seen, each is a fraction of
// a millisecond; for what it has not — the first run after a shader changed —
// each can be hundreds of milliseconds of the main thread for a large shader,
// which is where JavaScript runs and every timer waits.
//
// The completion-handler variants compile on Metal's own threads instead. A
// job here holds what it produced under a lock; the main thread polls it and
// takes the result when it is ready, and the handler wakes the run loop so a
// pump blocked in AppKit comes back to look. Nothing crosses into JavaScript
// from another thread.

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include "bridge.h"

typedef struct BRCompile {
  pthread_mutex_t lock;
  int state;       // 0 compiling, 1 compiled, -1 failed
  id result;       // the library or pipeline state, retained until taken
  id reflection;   // a pipeline's reflection, retained until taken (or nil)
  char* error;     // malloc'd UTF-8, or NULL
  int refs;        // the caller's and the handler's
} BRCompile;

// Let go of one reference; the last frees the job and anything not taken.
static void compile_unref(BRCompile* c) {
  pthread_mutex_lock(&c->lock);
  int left = --c->refs;
  pthread_mutex_unlock(&c->lock);
  if (left > 0) return;
  if (c->result) [c->result release];
  if (c->reflection) [c->reflection release];
  free(c->error);
  pthread_mutex_destroy(&c->lock);
  free(c);
}

// A new job, with one reference for the caller and one for the handler, which
// may run on any thread — or before the call that starts it returns.
static BRCompile* compile_new(void) {
  BRCompile* c = calloc(1, sizeof(BRCompile));
  if (!c) return NULL;
  pthread_mutex_init(&c->lock, NULL);
  c->refs = 2;
  return c;
}

// The handler's half: record what came back, let go, and wake the run loop.
static void compile_settle(BRCompile* c, id result, id reflection, NSError* error) {
  pthread_mutex_lock(&c->lock);
  if (result) {
    // A library with warnings still comes with an error object; it compiled.
    c->result = [result retain];
    c->reflection = reflection ? [reflection retain] : nil;
    c->state = 1;
  } else {
    const char* message = error ? [[error localizedDescription] UTF8String] : NULL;
    c->error = strdup(message ? message : "no message");
    c->state = -1;
  }
  pthread_mutex_unlock(&c->lock);
  compile_unref(c);
  // A pump blocked in AppKit comes back now rather than at its timeout.
  br_post_empty_event();
}

void* br_library_compile(void* device, const char* source) {
  if (!device || !source) return NULL;
  BRCompile* c = compile_new();
  if (!c) return NULL;
  @autoreleasepool {
    NSString* text = [NSString stringWithUTF8String:source];
    if (!text) {
      compile_settle(c, nil, nil, nil);
      return c;
    }
    [(id<MTLDevice>)device newLibraryWithSource:text
                                        options:nil
                              completionHandler:^(id<MTLLibrary> library, NSError* error) {
      compile_settle(c, library, nil, error);
    }];
  }
  return c;
}

void* br_render_pipeline_compile(void* device, void* descriptor, uint64_t options) {
  if (!device || !descriptor) return NULL;
  BRCompile* c = compile_new();
  if (!c) return NULL;
  @autoreleasepool {
    [(id<MTLDevice>)device
        newRenderPipelineStateWithDescriptor:(MTLRenderPipelineDescriptor*)descriptor
                                     options:(MTLPipelineOption)options
                           completionHandler:^(id<MTLRenderPipelineState> state,
                                               MTLRenderPipelineReflection* reflection,
                                               NSError* error) {
      compile_settle(c, state, reflection, error);
    }];
  }
  return c;
}

void* br_compute_pipeline_compile(void* device, void* function, uint64_t options) {
  if (!device || !function) return NULL;
  BRCompile* c = compile_new();
  if (!c) return NULL;
  @autoreleasepool {
    [(id<MTLDevice>)device
        newComputePipelineStateWithFunction:(id<MTLFunction>)function
                                    options:(MTLPipelineOption)options
                          completionHandler:^(id<MTLComputePipelineState> state,
                                              MTLComputePipelineReflection* reflection,
                                              NSError* error) {
      compile_settle(c, state, reflection, error);
    }];
  }
  return c;
}

int br_compile_poll(void* job) {
  BRCompile* c = (BRCompile*)job;
  if (!c) return -1;
  pthread_mutex_lock(&c->lock);
  int state = c->state;
  pthread_mutex_unlock(&c->lock);
  return state;
}

void* br_compile_take(void* job) {
  BRCompile* c = (BRCompile*)job;
  if (!c) return NULL;
  pthread_mutex_lock(&c->lock);
  id result = c->result;
  c->result = nil;
  pthread_mutex_unlock(&c->lock);
  return result; // +1: the caller releases it
}

void* br_compile_take_reflection(void* job) {
  BRCompile* c = (BRCompile*)job;
  if (!c) return NULL;
  pthread_mutex_lock(&c->lock);
  id reflection = c->reflection;
  c->reflection = nil;
  pthread_mutex_unlock(&c->lock);
  return reflection; // +1, or NULL
}

const char* br_compile_error(void* job) {
  BRCompile* c = (BRCompile*)job;
  if (!c) return NULL;
  pthread_mutex_lock(&c->lock);
  const char* error = c->error;
  pthread_mutex_unlock(&c->lock);
  return error;
}

void br_compile_free(void* job) {
  BRCompile* c = (BRCompile*)job;
  if (!c) return;
  compile_unref(c);
}
