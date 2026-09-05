import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "three.js webgl - geometry - minecraft",
  description: "three.js minecraft demo set up in a Next.js workspace, ready for game conversion.",
  keywords: ["Z.ai", "Next.js", "TypeScript", "Tailwind CSS", "shadcn/ui", "AI development", "React"],
  authors: [{ name: "Z.ai Team" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "Z.ai Code Scaffold",
    description: "AI-powered development with modern React stack",
    url: "https://chat.z.ai",
    siteName: "Z.ai",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Z.ai Code Scaffold",
    description: "AI-powered development with modern React stack",
  },
  /** Installed-app path to a maximized game: when the player uses
   *  "Add to Home Screen", RATFIRE launches with NO Safari chrome at all
   *  (the black-translucent status bar floats transparently over the
   *  canvas). Works together with the in-browser Fullscreen API
   *  auto-request in page.tsx and the web app manifest. */
  appleWebApp: {
    capable: true,
    title: "RATFIRE",
    statusBarStyle: "black-translucent",
  },
};

/** Mobile game viewport: no pinch-zoom / double-tap zoom interference with
 *  the touch controls, and `viewportFit: cover` exposes the iOS safe-area
 *  insets the touch HUD pads itself with. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground overscroll-none`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
