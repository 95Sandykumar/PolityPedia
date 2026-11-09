import type { Metadata, Viewport } from 'next';
import { Noto_Sans_Devanagari } from 'next/font/google';
import { ServiceWorkerRegister } from '@/components/service-worker-register';
import './globals.css';

const noto = Noto_Sans_Devanagari({
  subsets: ['latin', 'devanagari'],
  weight: ['400', '500', '700'],
  variable: '--font-noto',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'PolityPedia',
  description: 'Political Science practice for UGC NET, CUET PG, TGT and PGT.',
  manifest: '/manifest.webmanifest',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#4F46E5',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={noto.variable}>
      <body>
        <ServiceWorkerRegister />
        {children}
      </body>
    </html>
  );
}
