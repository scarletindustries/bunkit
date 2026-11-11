// Dialogs: sheets, never runModal — even with no window on screen.
//
// runModal spins a nested run loop that br_pump never returns from, freezing every JavaScript
// timer for as long as the dialog is up (an app's show clock included). With nothing on screen
// to hang a sheet from, an alert hangs from a transparent host panel instead; this checks that
// the call returns at once, the alert is a sheet on that host, and ending it resolves the promise
// and takes the host away.

import { initApp, pumpOnce } from "../src/runtime.ts";
import { objc } from "../src/objc.ts";
import { alert, prompt } from "../src/ui/dialogs.ts";

let failures = 0;
function check(name: string, cond: unknown, extra?: unknown) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}`, extra ?? "");
  }
}

initApp();

/** The visible windows that carry a sheet right now. */
function sheetHosts(): any[] {
  const list = objc.NSApplication.sharedApplication().windows();
  const out: any[] = [];
  for (let i = 0; i < Number(list.count()); i++) {
    const w = list.objectAtIndex_(i);
    if (Boolean(w.isVisible()) && w.attachedSheet() && w.attachedSheet().ptr) out.push(w);
  }
  return out;
}

{
  const started = performance.now();
  let settled: { button: number } | undefined;
  const pending = alert({ title: "No window", message: "Hung from a host.", buttons: ["OK", "Cancel"] })
    .then((r) => (settled = r));
  const returnedMs = performance.now() - started;
  check("an alert with no window on screen returns at once (no runModal)", returnedMs < 500, returnedMs);
  for (let i = 0; i < 20; i++) pumpOnce(0.01);
  const hosts = sheetHosts();
  check("it is a sheet on a host window", hosts.length === 1, hosts.length);
  const host = hosts[0];
  // Choose the second button, as a click would.
  host?.endSheet_returnCode_(host.attachedSheet(), 1001);
  for (let i = 0; i < 20 && !settled; i++) {
    pumpOnce(0.01);
    await Promise.resolve();
  }
  await Promise.race([pending, Bun.sleep(200)]);
  check("ending the sheet resolves the alert with the button chosen", settled?.button === 1, settled);
  check("and takes the host away", host && !Boolean(host.isVisible()));
}

{
  let answer: string | null | undefined;
  const pending = prompt("Name it", { value: "Chorus" }).then((r) => (answer = r));
  for (let i = 0; i < 20; i++) pumpOnce(0.01);
  const host = sheetHosts()[0];
  check("a prompt with no window is a sheet on a host too", Boolean(host));
  host?.endSheet_returnCode_(host.attachedSheet(), 1000);
  await Promise.race([pending, Bun.sleep(200)]);
  check("and answers with its field", answer === "Chorus", answer);
}

console.log(failures === 0 ? "\nALL DIALOG TESTS PASSED" : `\n${failures} DIALOG FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
