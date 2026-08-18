import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-screen flex-col bg-june-paper">
      <SiteHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter />
    </div>
  );
}
