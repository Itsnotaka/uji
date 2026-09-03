import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { sessionId } from "@uji-ai/core";
import {
  createSessionDragSource,
  endSessionDrag,
  hasReachedSessionDragActivation,
  SESSION_DRAG_ACTIVATION_DISTANCE,
} from "../src/renderer/src/layout/session-drag.ts";

afterEach(() => endSessionDrag());

void describe("session pointer drag", () => {
  test("activates only after Cursor's eight-pixel movement threshold", () => {
    const origin = { clientX: 20, clientY: 30 };

    assert.equal(SESSION_DRAG_ACTIVATION_DISTANCE, 8);
    assert.equal(hasReachedSessionDragActivation(origin, { clientX: 27.99, clientY: 30 }), false);
    assert.equal(hasReachedSessionDragActivation(origin, { clientX: 28, clientY: 30 }), true);
    assert.equal(hasReachedSessionDragActivation(origin, { clientX: 26, clientY: 36 }), true);
  });

  test("disables the browser's native drag path", () => {
    const source = createSessionDragSource(sessionId("session-1"));
    let prevented = false;

    assert.equal(source.draggable, false);
    source.onDragStart({
      preventDefault() {
        prevented = true;
      },
    });
    assert.equal(prevented, true);
  });
});
