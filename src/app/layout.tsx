import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { StatusBar } from "@/components/terminal/StatusBar";
import { NavBar } from "@/components/terminal/NavBar";
import { EligibilityGate } from "@/components/terminal/EligibilityGate";

export const metadata: Metadata = {
  title: "POLYQUANT Terminal",
  description:
    "Polymarket trading analytics terminal — explainable signals, risk engine, paper trading.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <EligibilityGate>
            <div className="flex min-h-screen flex-col">
              <StatusBar />
              <NavBar />
              <main className="flex-1 p-2">{children}</main>
              <footer className="border-t border-line px-2 py-1 text-3xs text-ink-faint">
                POLYQUANT is an analytics tool. Event markets involve risk of
                total loss. Nothing here is investment advice; backtests and
                simulations are hypothetical and demo data is clearly-labeled
                sample data, not real performance.
              </footer>
            </div>
          </EligibilityGate>
        </Providers>
      </body>
    </html>
  );
}
