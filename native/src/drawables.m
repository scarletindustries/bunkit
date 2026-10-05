// drawables.m — take a CAMetalLayer's next drawable on a thread of its own.
//
// -[CAMetalLayer nextDrawable] blocks until the display lets go of one, and a
// view that draws as often as the run loop comes round spends most of a
// refresh in there — on the main thread, which is also where JavaScript runs.
// So the wait happens here instead: a background thread keeps one drawable
// ready, taking the next the moment the display frees it, and wakes the run
// loop when it has one. The main thread only ever takes a drawable that is
// already free, and a view knows a frame is due exactly when one is.
//
// Calling nextDrawable off the main thread is how Apple's own custom-view
// samples render; the layer serialises it internally.

#import <QuartzCore/QuartzCore.h>
#import <Metal/Metal.h>
#include <pthread.h>
#include "bridge.h"

typedef struct BRDrawablePump {
  CAMetalLayer* layer;       // retained
  pthread_mutex_t lock;
  pthread_cond_t cond;
  id<CAMetalDrawable> ready; // retained, or nil
  int armed;                 // keep a drawable ready
  int stopped;
} BRDrawablePump;

static void pump_free(BRDrawablePump* p) {
  if (p->ready) [p->ready release];
  [p->layer release];
  pthread_mutex_destroy(&p->lock);
  pthread_cond_destroy(&p->cond);
  free(p);
}

static void* pump_thread(void* arg) {
  BRDrawablePump* p = (BRDrawablePump*)arg;
  pthread_setname_np("bunkit-drawables");
  pthread_mutex_lock(&p->lock);
  for (;;) {
    while (!p->stopped && (!p->armed || p->ready)) pthread_cond_wait(&p->cond, &p->lock);
    if (p->stopped) break;
    pthread_mutex_unlock(&p->lock);

    id<CAMetalDrawable> drawable = nil;
    @autoreleasepool {
      // Blocks until the display frees one — here, not on the main thread. Times
      // out after a second (allowsNextDrawableTimeout) and comes round again.
      drawable = [[p->layer nextDrawable] retain];
    }

    pthread_mutex_lock(&p->lock);
    if (!drawable) continue;
    if (p->stopped || !p->armed || p->ready) {
      [drawable release];
      continue;
    }
    p->ready = drawable;
    pthread_mutex_unlock(&p->lock);
    // The run loop may be asleep in the pump: a frame is due now, not at its timeout.
    br_post_empty_event();
    pthread_mutex_lock(&p->lock);
  }
  pthread_mutex_unlock(&p->lock);
  pump_free(p);
  return NULL;
}

void* br_drawables_create(void* layer) {
  if (!layer) return NULL;
  BRDrawablePump* p = calloc(1, sizeof(BRDrawablePump));
  if (!p) return NULL;
  p->layer = [(CAMetalLayer*)layer retain];
  pthread_mutex_init(&p->lock, NULL);
  pthread_cond_init(&p->cond, NULL);
  pthread_t thread;
  if (pthread_create(&thread, NULL, pump_thread, p) != 0) {
    pump_free(p);
    return NULL;
  }
  // The thread owns the struct from here and frees it when stopped: a stop never
  // waits out a nextDrawable that is still blocked.
  pthread_detach(thread);
  return p;
}

void br_drawables_arm(void* pump, int on) {
  BRDrawablePump* p = (BRDrawablePump*)pump;
  if (!p) return;
  id<CAMetalDrawable> dropped = nil;
  pthread_mutex_lock(&p->lock);
  p->armed = on ? 1 : 0;
  if (!on) {
    dropped = p->ready;
    p->ready = nil;
  }
  pthread_cond_signal(&p->cond);
  pthread_mutex_unlock(&p->lock);
  if (dropped) [dropped release];
}

int br_drawables_ready(void* pump) {
  BRDrawablePump* p = (BRDrawablePump*)pump;
  if (!p) return 0;
  pthread_mutex_lock(&p->lock);
  int ready = p->ready != nil;
  pthread_mutex_unlock(&p->lock);
  return ready;
}

void* br_drawables_take(void* pump) {
  BRDrawablePump* p = (BRDrawablePump*)pump;
  if (!p) return NULL;
  pthread_mutex_lock(&p->lock);
  id<CAMetalDrawable> drawable = p->ready;
  p->ready = nil;
  pthread_cond_signal(&p->cond);
  pthread_mutex_unlock(&p->lock);
  return drawable; // +1: the caller releases it
}

void br_drawables_destroy(void* pump) {
  BRDrawablePump* p = (BRDrawablePump*)pump;
  if (!p) return;
  pthread_mutex_lock(&p->lock);
  p->stopped = 1;
  pthread_cond_signal(&p->cond);
  pthread_mutex_unlock(&p->lock);
}
