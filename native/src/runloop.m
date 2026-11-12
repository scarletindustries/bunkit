// runloop.m — cooperative coexistence between AppKit's run loop and Bun's.
//
// We never call -[NSApplication run]. JS owns the outer loop and calls br_pump
// repeatedly; each call blocks in mach_msg for at most `seconds` waiting for the
// next event, then drains whatever else is queued without blocking.

#import <Cocoa/Cocoa.h>
#include <mach/mach_time.h>
#include <stdatomic.h>
#include "bridge.h"

typedef void (*br_void_fn)(uint32_t, uint32_t, void*, void*);

static volatile int g_stop = 0;
static int          g_quit_after_last_window = 1;
static br_void_fn   g_stop_cb = NULL;

// ---------------------------------------------------------------------------
// Application delegate
// ---------------------------------------------------------------------------

@interface BRAppDelegate : NSObject <NSApplicationDelegate>
@end

@implementation BRAppDelegate

// Cmd-Q and the Dock's Quit both land here. We refuse AppKit's own exit() path
// so JS gets a chance to unwind, save state and shut the loop down itself.
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication*)sender {
  (void)sender;
  g_stop = 1;
  if (g_stop_cb) g_stop_cb(0, 0, NULL, NULL);
  return NSTerminateCancel;
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication*)sender {
  (void)sender;
  return g_quit_after_last_window ? YES : NO;
}

- (void)brNoop:(id)sender { (void)sender; }

@end

static BRAppDelegate* g_delegate = nil;

static void br_uncaught(NSException* e) {
  NSLog(@"[objcbridge] UNCAUGHT Obj-C exception: %@: %@\n%@",
        [e name], [e reason], [e callStackSymbols]);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

void br_app_init(int activationPolicy) {
  static int done = 0;
  if (done) return;
  done = 1;
  NSSetUncaughtExceptionHandler(&br_uncaught);
  [NSApplication sharedApplication];
  [NSApp setActivationPolicy:(NSApplicationActivationPolicy)activationPolicy];
  g_delegate = [[BRAppDelegate alloc] init];
  [NSApp setDelegate:g_delegate];
  [NSApp finishLaunching];
  [NSApp activateIgnoringOtherApps:YES];
}

void br_set_terminate_after_last_window(int v) { g_quit_after_last_window = v; }

void br_set_stop_callback(void* cb) { g_stop_cb = (br_void_fn)cb; }

void br_stop(void)     { g_stop = 1; }
int  br_should_stop(void) { return g_stop; }

// ---------------------------------------------------------------------------
// The pump
// ---------------------------------------------------------------------------

// A wake-up event posted by br_wake_pump and not yet taken off AppKit's queue,
// and the data1 that marks one.
static atomic_int g_wake_pending;
#define BR_WAKE_MARK 0x77616b65 /* 'wake' */

int br_pump(double seconds) {
  if (!NSApp) return 0;
  static int idleTicks = 0;
  int n = 0;
  // A safe point for the main loop for as long as this runs (docs/main-loop/spec.md §3): the
  // only JavaScript below is whoever called the pump, which waits for it to return.
  atomic_fetch_add(&g_br_main.inPump, 1);
  double started = br_now();
  // A turn that came due while JavaScript was busy, and calls trampolined since the last pump.
  br_main_run_pending();
  @autoreleasepool {
    NSDate* deadline = seconds > 0 ? [NSDate dateWithTimeIntervalSinceNow:seconds]
                                   : [NSDate distantPast];
    NSEvent* e;
    for (;;) {
      int waiting = br_main_pump_wait_begin();
      e = [NSApp nextEventMatchingMask:NSEventMaskAny
                             untilDate:deadline
                                inMode:NSDefaultRunLoopMode
                               dequeue:YES];
      br_main_pump_wait_end(waiting);
      if (!e) break;
      // Taken: the next wake-up must post again. Cleared here, not when a pump
      // starts — between two pumps is exactly when JavaScript sends something and
      // the answer arrives, and a flag still set then would let the next pump sleep.
      if ([e type] == NSEventTypeApplicationDefined && [e data1] == BR_WAKE_MARK) {
        atomic_store(&g_wake_pending, 0);
      }
      // A menu, a live resize or a slider drag runs its own loop in here; the main loop's turns
      // run inside it, between the callbacks AppKit makes.
      br_main_dispatch_begin();
      @try {
        [NSApp sendEvent:e];
      } @catch (NSException* ex) {
        NSLog(@"[objcbridge] exception in sendEvent: %@: %@", [ex name], [ex reason]);
      }
      br_main_dispatch_end();
      n++;
      br_main_run_pending();
      // Everything after the first event is drained without blocking.
      deadline = [NSDate distantPast];
    }
    // -updateWindows walks every window and is pure overhead when nothing
    // happened, which is most of the time in an idle app. Run it whenever we
    // handled events, and occasionally otherwise so cursor rects and field
    // editors still get their housekeeping.
    if (n > 0 || ++idleTicks >= 50) {
      idleTicks = 0;
      @try {
        [NSApp updateWindows];
      } @catch (NSException* ex) {
        NSLog(@"[objcbridge] exception in updateWindows: %@", [ex reason]);
      }
    }
  }
  br_main_run_pending();
  // And here: one of AppKit's own nested loops (menu tracking, a modal session)
  // may have taken the event instead, and a flag left set would stop every wake-up
  // after it. At worst a second event is posted while one is still queued.
  atomic_store(&g_wake_pending, 0);
  br_main_pump_end(br_now() - started);
  atomic_fetch_sub(&g_br_main.inPump, 1);
  return n;
}

// Wake a pump that is blocked in mach_msg (e.g. because JS has work to do).
void br_post_empty_event(void) {
  if (!NSApp) return;
  @autoreleasepool {
    NSEvent* e = [NSEvent otherEventWithType:NSEventTypeApplicationDefined
                                    location:NSZeroPoint
                               modifierFlags:0
                                   timestamp:0
                                windowNumber:0
                                     context:nil
                                     subtype:0
                                       data1:0
                                       data2:0];
    [NSApp postEvent:e atStart:YES];
  }
}

// Wake the pump from another thread: post one empty event unless one is already
// waiting. A pump asleep in AppKit returns at once; a main thread between two
// pumps finds it at the start of the next and does not sleep there. At most one
// is outstanding per pump, so a process that stops pumping does not collect them.
void br_wake_pump(void) {
  if (!NSApp) return;
  if (atomic_exchange(&g_wake_pending, 1)) return;
  @autoreleasepool {
    NSEvent* e = [NSEvent otherEventWithType:NSEventTypeApplicationDefined
                                    location:NSZeroPoint
                               modifierFlags:0
                                   timestamp:0
                                windowNumber:0
                                     context:nil
                                     subtype:0
                                       data1:BR_WAKE_MARK
                                       data2:0];
    [NSApp postEvent:e atStart:YES];
  }
}

double br_now(void) {
  static mach_timebase_info_data_t tb;
  if (tb.denom == 0) mach_timebase_info(&tb);
  uint64_t t = mach_absolute_time();
  return (double)t * (double)tb.numer / (double)tb.denom / 1e9;
}

// Convenience used by the packaging layer: the running executable's bundle path.
const char* br_bundle_path(void) {
  return [[[NSBundle mainBundle] bundlePath] UTF8String];
}
