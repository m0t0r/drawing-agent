import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import "./globals.css";

// Inter backs `--font-sans` because the design system's preset asks for it;
// Geist Mono backs `--font-mono`, which the preset has no opinion about.
const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Drawing Agent",
  description: "Draw diagrams from a prompt",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${geistMono.variable} h-full font-sans antialiased`}
    >
      {/*
        `h-full`, not `min-h-full`: Excalidraw sizes itself with `height: 100%`,
        and a percentage only resolves against a definite height. `min-height`
        leaves the chain indefinite, which collapses the canvas to 0px.
      */}
      <body className="flex h-full flex-col">{children}</body>
    </html>
  );
}
