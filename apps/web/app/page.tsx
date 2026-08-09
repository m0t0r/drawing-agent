import { Canvas } from "../components/canvas";
import { ChatSidebar } from "../components/chat-sidebar";
import { ExcalidrawProvider } from "../components/excalidraw-provider";

export default function Page() {
  return (
    <ExcalidrawProvider>
      <div className="flex min-h-0 flex-1">
        {/* `min-w-0` so the canvas can shrink rather than push the sidebar off. */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <Canvas />
        </div>
        <aside className="hidden h-full w-96 shrink-0 border-s md:block">
          <ChatSidebar />
        </aside>
      </div>
    </ExcalidrawProvider>
  );
}
