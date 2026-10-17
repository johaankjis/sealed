import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata = {
  title: "Sealed — Private-data insights marketplace",
  description:
    "Pay for AI-generated insights from private datasets. The data stays sealed inside its sandbox; only validated aggregate results reach you.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="site-shell">
          <header className="site-header">
            <div className="site-header-inner">
              <Link className="wordmark" href="/">
                Sealed<em>.</em>
              </Link>
              <nav className="site-nav" aria-label="Primary">
                <Link href="/">Marketplace</Link>
                <Link href="/#how-it-works">How it works</Link>
                <Link href="/jobs/demo">Demo result</Link>
              </nav>
            </div>
          </header>
          <main>{children}</main>
          <footer className="site-footer">
            <div className="site-footer-inner">
              <p>Sealed · insights without exposure. Raw datasets never leave their sandboxes.</p>
              <p className="seal">EST. MMXXVI — HANDLE WITH CARE</p>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
