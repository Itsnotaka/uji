import { Card } from "fumadocs-ui/components/card";
import { docsIcons, isDocsIconName } from "@/lib/docs-icons";

function CentralIcon({ name }: { name: string }) {
  if (!isDocsIconName(name)) return null;
  const Icon = docsIcons[name];
  return <Icon size={20} />;
}

/*
 * Fumadocs Card with a Central Icons glyph. Sidebar icons resolve from
 * frontmatter through source.ts; cards on overview pages use this so the
 * same names work in MDX.
 */
export function DocCard({
  icon,
  title,
  href,
  description,
}: {
  icon: string;
  title: string;
  href: string;
  description: string;
}) {
  return (
    <Card icon={<CentralIcon name={icon} />} title={title} href={href} description={description} />
  );
}
