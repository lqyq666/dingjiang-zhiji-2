import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";
import { SessionGate } from "./components/session-gate";

export const metadata: Metadata = {
  title: "鼎江智绩 2.0",
  description: "AI 增强型企业经营诊断与改善工作系统",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <SessionGate>{children}</SessionGate>
      </body>
    </html>
  );
}
