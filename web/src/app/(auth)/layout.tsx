import Link from "next/link";
import { Logo } from "@/components/brand/logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main id="main" className="tech-grid flex min-h-[100svh] flex-col bg-ink-950 text-bone-50">
      <div className="px-6 py-6">
        <Link href="/" aria-label="ORYN — home" className="inline-block">
          <Logo className="h-5 w-auto" />
        </Link>
      </div>
      <div className="flex flex-1 items-center justify-center px-4 pb-20">
        <div className="w-full max-w-[400px]">{children}</div>
      </div>
    </main>
  );
}
