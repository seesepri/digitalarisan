import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "seearisan — Arisan digital yang transparan",
  description: "Kelola arisan, saldo tersedia, dana terkunci, drawing, dan riwayat transaksi dengan transparan.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id">
      <body className="antialiased">{children}</body>
    </html>
  );
}
