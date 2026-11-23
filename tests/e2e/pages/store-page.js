// Runs one scenario of store-worker.js in a fresh worker and resolves with what it posts back.
// `hold: true` leaves the worker alive (a write it began stays open) until `release()`.
const held = [];

window.inWorker = (scenario, opts = {}) =>
  new Promise((resolve) => {
    const w = new Worker("/store-worker.js", { type: "module" });
    w.onmessage = (e) => {
      if (opts.hold) held.push(w);
      else w.terminate();
      resolve(e.data);
    };
    w.onerror = (e) => resolve({ error: `worker error: ${e.message}` });
    w.postMessage(scenario);
  });

window.release = () => {
  for (const w of held.splice(0)) w.terminate();
};
