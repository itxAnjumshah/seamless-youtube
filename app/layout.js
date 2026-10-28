import "./globals.css";

export const metadata = {
  title: "Streamline | Video downloader",
  description: "Analyze and download YouTube videos and authorized media files.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
