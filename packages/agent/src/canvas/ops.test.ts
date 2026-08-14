import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { addElements } from "./ops";

/** A minimal runtime element, standing in for something already on the canvas. */
function existingRectangle(id: string): ExcalidrawElement {
  return { id, type: "rectangle", x: 0, y: 0, width: 10, height: 10 } as ExcalidrawElement;
}

describe("addElements", () => {
  it("appends to the scene rather than replacing it", () => {
    const scene = [existingRectangle("already-here")];

    const next = addElements(scene, {
      elements: [{ type: "rectangle", x: 100, y: 100, width: 240, height: 120 }],
    });

    expect(next).toHaveLength(2);
    expect(next[0]?.id).toBe("already-here");
    expect(next[1]?.type).toBe("rectangle");
  });

  it("leaves the scene it was given untouched", () => {
    const scene = [existingRectangle("already-here")];

    addElements(scene, { elements: [{ type: "ellipse", x: 0, y: 0 }] });

    expect(scene).toHaveLength(1);
  });

  it("converts skeletons to runtime elements, so a label becomes a bound text element", () => {
    const next = addElements([], {
      elements: [
        {
          type: "rectangle",
          id: "box",
          x: 0,
          y: 0,
          width: 240,
          height: 120,
          label: { text: "hi" },
        },
      ],
    });

    const container = next.find((element) => element.type === "rectangle");
    const text = next.find((element) => element.type === "text");

    // The skeleton said `label: { text }`. The runtime graph says it twice, from
    // both ends — that is the whole point of the distinction.
    expect(text).toBeDefined();
    expect(text).toMatchObject({ containerId: container?.id });
    expect(container?.boundElements).toContainEqual({ type: "text", id: text?.id });
  });

  it("keeps the ids the caller chose, so later ops can refer to them", () => {
    const next = addElements([], {
      elements: [{ type: "rectangle", id: "box", x: 0, y: 0, width: 240, height: 120 }],
    });

    expect(next[0]?.id).toBe("box");
  });

  it("assigns an id to a skeleton that arrived without one", () => {
    const next = addElements([], { elements: [{ type: "rectangle", x: 0, y: 0 }] });

    expect(next[0]?.id).toEqual(expect.any(String));
    expect(next[0]?.id).not.toBe("");
  });

  it("strips nulls, which strict-mode tool schemas emit for absent optional fields", () => {
    const next = addElements([], {
      elements: [
        {
          type: "rectangle",
          x: 0,
          y: 0,
          // A strict-mode schema cannot mark a property optional, so "no
          // background colour" arrives as an explicit null. Excalidraw's
          // defaults are parameter defaults, which null does not trigger.
          backgroundColor: null,
          label: null,
        } as never,
      ],
    });

    expect(next[0]?.backgroundColor).toBe("transparent");
  });

  it("strips nulls nested inside a skeleton", () => {
    const next = addElements([], {
      elements: [
        {
          type: "rectangle",
          x: 0,
          y: 0,
          width: 240,
          height: 120,
          label: { text: "hi", fontSize: null },
        } as never,
      ],
    });

    const text = next.find((element) => element.type === "text");

    expect(text).toMatchObject({ fontSize: 20 });
  });
});
