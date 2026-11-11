import {
  PointerSensor,
  closestCenter,
  type CollisionDetection,
  type Modifiers,
  type PointerSensorOptions,
  type SensorProps,
} from "@dnd-kit/core";
import { flushSync } from "react-dom";

function chatAtPoint(document: Document, x: number, y: number) {
  return document.elementFromPoint(x, y)
    ?.closest<HTMLElement>("[data-sidebar-sortable-chat-id]")
    ?.dataset.sidebarSortableChatId ?? "";
}

export const detectSidebarChatCollisions: CollisionDetection = (args) => {
  if (!args.pointerCoordinates) return closestCenter(args);

  // Hit-test the visible row, including the sidebar's scroll clipping.
  const { x, y } = args.pointerCoordinates;
  const id = chatAtPoint(document, x, y);
  return args.droppableContainers.some((container) => container.id === id)
    ? [{ id }]
    : [];
};

export const sidebarChatDragModifiers: Modifiers = [
  ({ transform }) => ({ ...transform, x: 0 }),
];

type SidebarChatPointerOptions = PointerSensorOptions & {
  capturePointer: boolean;
  onRelease: (chatId: string) => void;
};

export class SidebarChatPointerSensor extends PointerSensor {
  constructor(props: SensorProps<SidebarChatPointerOptions>) {
    const { activeNode, options } = props;
    const row = activeNode.node.current;
    if (!row) {
      super(props);
      return;
    }

    const { pointerId, clientX, clientY } = props.event as PointerEvent;
    const document = row.ownerDocument;
    const view = document.defaultView;
    const activationPoint = { x: clientX, y: clientY };
    let started = false;
    const cancel = () => {
      // Use the sensor's cancellation path so its document listeners are removed too.
      document.dispatchEvent(new PointerEvent("pointercancel", { pointerId }));
    };
    const trackMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      if ((event.buttons & 1) === 0) {
        // Recover when the press ended outside the shell and no pointerup arrived.
        cancel();
      } else if (!started) {
        activationPoint.x = event.clientX;
        activationPoint.y = event.clientY;
      }
    };
    const trackRelease = (event: PointerEvent) => {
      if (event.pointerId === pointerId) {
        options.onRelease(chatAtPoint(document, event.clientX, event.clientY));
      }
    };
    const cancelOnCaptureLoss = (event: PointerEvent) => {
      // Capture may be lost while the mouse is still held. Keep the document
      // listeners active for that gesture's next move or release.
      if (event.pointerId === pointerId && event.buttons === 0) cancel();
    };
    const cleanup = () => {
      document.removeEventListener("pointermove", trackMove, true);
      document.removeEventListener("pointerup", trackRelease, true);
      document.removeEventListener("lostpointercapture", cancelOnCaptureLoss, true);
      view?.removeEventListener("blur", cancel);
      if (options.capturePointer && row.hasPointerCapture(pointerId)) {
        try {
          row.releasePointerCapture(pointerId);
        } catch {
          // Chromium may have already ended the pointer.
        }
      }
    };

    super({
      ...props,
      onStart(coordinates) {
        started = true;
        if (options.capturePointer && row.isConnected) {
          // Keep Windows releases in the shell across webviews. Capture on the
          // wrapper so the release cannot become a click on the chat button.
          try {
            row.setPointerCapture(pointerId);
          } catch {
            // The document sensor still handles the gesture if capture is unavailable.
          }
        }
        // Commit the activating move before an immediate pointerup reads the drag state.
        flushSync(() => {
          props.onStart(coordinates);
          props.onMove(activationPoint);
        });
      },
      onEnd() {
        cleanup();
        props.onEnd();
      },
      onCancel() {
        cleanup();
        props.onCancel();
      },
    });
    document.addEventListener("pointermove", trackMove, true);
    document.addEventListener("pointerup", trackRelease, true);
    document.addEventListener("lostpointercapture", cancelOnCaptureLoss, true);
    view?.addEventListener("blur", cancel);
  }
}
