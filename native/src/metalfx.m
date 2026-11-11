// metalfx.m — build MetalFX's effects on a thread of their own, not the caller's.
//
// -[MTLFXTemporalScalerDescriptor newTemporalScalerWithDevice:] returns only once
// MetalFX has made the effect's pipelines. Measured on an M2 Pro (macOS 26.6),
// with requiresSynchronousInitialization off: 50–90 ms for a temporal scaler,
// 320 ms for the first one in a process with dynamic resolution, 1.4 s with it
// on; 250 ms for a frame interpolator. On the main thread — where JavaScript
// runs, and with it anything that keeps time — that is several frames held.
//
// A job here makes the effect on a background queue and holds it under a lock;
// the caller polls it and takes the effect when it is ready, as compile.m's
// jobs do, and the queue wakes the run loop when it is done. Nothing crosses
// into JavaScript from another thread. The descriptor is copied before the
// call returns, so the caller may change or release its own at once.
//
// MetalFX.framework is not linked: its classes are found at run time (the
// TypeScript side loads the framework), and only its selectors are used here.

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <MetalFX/MetalFX.h>
#include <dispatch/dispatch.h>
#include <pthread.h>
#include <stdlib.h>
#include "bridge.h"

typedef struct BRFxJob {
  pthread_mutex_t lock;
  int state;  // 0 building, 1 built, -1 failed
  id result;  // the effect, retained until taken
  int refs;   // the caller's and the builder's
} BRFxJob;

// Let go of one reference; the last frees the job and anything not taken.
static void fx_unref(BRFxJob* j) {
  pthread_mutex_lock(&j->lock);
  int left = --j->refs;
  pthread_mutex_unlock(&j->lock);
  if (left > 0) return;
  if (j->result) [j->result release];
  pthread_mutex_destroy(&j->lock);
  free(j);
}

void* br_fx_create(void* device, void* descriptor, int kind) {
  if (!device || !descriptor || kind < 0 || kind > 2) return NULL;
  BRFxJob* j = calloc(1, sizeof(BRFxJob));
  if (!j) return NULL;
  pthread_mutex_init(&j->lock, NULL);
  j->refs = 2;
  id<MTLDevice> dev = [(id<MTLDevice>)device retain];
  id desc = [(id<NSCopying>)descriptor copyWithZone:nil]; // +1, ours
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
    id made = nil;
    @autoreleasepool {
      @try {
        if (kind == 0) made = [(MTLFXTemporalScalerDescriptor*)desc newTemporalScalerWithDevice:dev];
        else if (kind == 1) made = [(MTLFXFrameInterpolatorDescriptor*)desc newFrameInterpolatorWithDevice:dev];
        else made = [(MTLFXSpatialScalerDescriptor*)desc newSpatialScalerWithDevice:dev];
      } @catch (NSException* e) {
        made = nil;
      }
    }
    pthread_mutex_lock(&j->lock);
    j->result = made; // +1 from new…, handed over to the job
    j->state = made ? 1 : -1;
    pthread_mutex_unlock(&j->lock);
    [desc release];
    [dev release];
    fx_unref(j);
    // A pump blocked in AppKit comes back now rather than at its timeout.
    br_post_empty_event();
  });
  return j;
}

int br_fx_poll(void* job) {
  BRFxJob* j = (BRFxJob*)job;
  if (!j) return -1;
  pthread_mutex_lock(&j->lock);
  int state = j->state;
  pthread_mutex_unlock(&j->lock);
  return state;
}

void* br_fx_take(void* job) {
  BRFxJob* j = (BRFxJob*)job;
  if (!j) return NULL;
  pthread_mutex_lock(&j->lock);
  id result = j->result;
  j->result = nil;
  pthread_mutex_unlock(&j->lock);
  return result; // +1: the caller releases it
}

void br_fx_free(void* job) {
  BRFxJob* j = (BRFxJob*)job;
  if (!j) return;
  fx_unref(j);
}
