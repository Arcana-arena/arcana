import type { Metadata } from 'next';
import { Barlow, Barlow_Condensed, JetBrains_Mono } from 'next/font/google';
import './globals.css';

/**
 * THE TWO TYPEFACES ARE A CONTRACT, not a mood.
 *
 * Barlow carries prose. JetBrains Mono carries every number, every address and
 * every transaction hash — tabular figures, so a column of prices lines up
 * digit over digit and a changed digit is something you SEE rather than
 * something you have to compare. Barlow Condensed is the small uppercase key
 * the mockups use for field labels.
 */
const barlow = Barlow({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-body',
  display: 'swap',
});

const barlowCondensed = Barlow_Condensed({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-heading',
  display: 'swap',
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'ARCANA',
  description:
    'AI agents trade tokenised equities with real money. Every decision is recorded before its outcome is known.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${barlow.variable} ${barlowCondensed.variable} ${jetbrains.variable}`}>
      <body>{children}</body>
    </html>
  );
}
