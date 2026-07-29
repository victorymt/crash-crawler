import assert from "node:assert/strict";
import test from "node:test";

test("waitForTabComplete installs listeners before checking tab state", async () => {
  const originalChrome = globalThis.chrome;
  const calls = [];
  const updateListeners = new Set();
  const removedListeners = new Set();

  globalThis.chrome = {
    tabs: {
      async get(tabId) {
        calls.push(`get:${tabId}`);
        return { id: tabId, status: "complete" };
      },
      onUpdated: {
        addListener(listener) {
          calls.push("updated:add");
          updateListeners.add(listener);
        },
        removeListener(listener) {
          calls.push("updated:remove");
          updateListeners.delete(listener);
        }
      },
      onRemoved: {
        addListener(listener) {
          calls.push("removed:add");
          removedListeners.add(listener);
        },
        removeListener(listener) {
          calls.push("removed:remove");
          removedListeners.delete(listener);
        }
      }
    }
  };

  try {
    const { waitForTabComplete } = await import(`../extension/src/providers/index.js?tab-order=${Date.now()}`);
    await waitForTabComplete(17, 100);

    assert.ok(calls.indexOf("updated:add") < calls.indexOf("get:17"));
    assert.ok(calls.indexOf("removed:add") < calls.indexOf("get:17"));
    assert.equal(updateListeners.size, 0);
    assert.equal(removedListeners.size, 0);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("waitForTabComplete settles once when competing tab events arrive", async () => {
  const originalChrome = globalThis.chrome;
  let updateListener = null;
  let removedListener = null;
  let updateRemovals = 0;
  let removedRemovals = 0;

  globalThis.chrome = {
    tabs: {
      async get(tabId) {
        return { id: tabId, status: "loading" };
      },
      onUpdated: {
        addListener(listener) { updateListener = listener; },
        removeListener(listener) {
          if (updateListener === listener) updateListener = null;
          updateRemovals += 1;
        }
      },
      onRemoved: {
        addListener(listener) { removedListener = listener; },
        removeListener(listener) {
          if (removedListener === listener) removedListener = null;
          removedRemovals += 1;
        }
      }
    }
  };

  try {
    const { waitForTabComplete } = await import(`../extension/src/providers/index.js?tab-events=${Date.now()}`);
    const pending = waitForTabComplete(23, 100);
    await Promise.resolve();
    const lateRemovedListener = removedListener;
    updateListener?.(23, { status: "complete" });
    lateRemovedListener?.(23);
    await pending;

    assert.equal(updateRemovals, 1);
    assert.equal(removedRemovals, 1);
  } finally {
    globalThis.chrome = originalChrome;
  }
});
