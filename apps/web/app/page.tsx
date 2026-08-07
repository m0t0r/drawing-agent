import { Canvas } from "../components/canvas";
import { DrawDemoButton } from "../components/draw-demo-button";
import { ExcalidrawProvider } from "../components/excalidraw-provider";

export default function Page() {
  return (
    <ExcalidrawProvider>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <Canvas />
        <DrawDemoButton />
      </div>
    </ExcalidrawProvider>
  );
}
