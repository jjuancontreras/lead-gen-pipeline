import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import SiteLoader from "@/components/SiteLoader";
import { brand } from "@/lib/content";

// PLACEHOLDER TYPEFACES - replace both from this project's DESIGN.md.
// Inter for the display face is a deliberate stand-in, not a choice: if the
// headings still look like body copy, the type system has not been set yet.
const display = Inter({
  variable: "--font-display-family",
  subsets: ["latin"],
  weight: ["700", "800"],
});

const body = Inter({
  variable: "--font-body-family",
  subsets: ["latin"],
});

// Revalidate daily so the footer's copyright year (and any other
// build-time-computed values) don't stay frozen for months between deploys.
export const revalidate = 86400;

export const metadata: Metadata = {
  title: brand.tagline ? `${brand.name} | ${brand.tagline}` : brand.name,
  description: brand.description,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} h-full`}>
      <body className="min-h-full flex flex-col bg-bg text-text antialiased">
        <SiteLoader />
        <Navbar />
        <main className="flex-1">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
