import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "USD/JPY Quant Engine", description: "Motor cuantitativo intradía USD/JPY" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
