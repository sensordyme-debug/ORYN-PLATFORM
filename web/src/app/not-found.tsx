import { LogoMark } from "@/components/brand/logo";
import { ButtonLink } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main id="main" className="tech-grid relative flex min-h-[100svh] items-center bg-ink-950 text-bone-50">
      <div className="shell py-32">
        <LogoMark className="h-12 w-auto text-bone-50/80" aria-hidden="true" />
        <p className="t-eyebrow mt-10 text-bone-50/50">Error 404</p>
        <h1 className="t-h1 mt-4 max-w-3xl">Nothing to see from up here.</h1>
        <p className="t-lead mt-6 max-w-xl text-bone-50/65">The page you&apos;re looking for doesn&apos;t exist or has moved.</p>
        <div className="mt-10 flex flex-col gap-3 sm:flex-row">
          <ButtonLink href="/">Back to home</ButtonLink>
          <ButtonLink href="/contact" variant="secondary">
            Contact us
          </ButtonLink>
        </div>
      </div>
    </main>
  );
}
