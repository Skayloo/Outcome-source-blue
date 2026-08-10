/**
 * The mark shown on surfaces a visitor sees before (or without) signing in: the login
 * screen and a guest link. On a tenant's domain that is THEIR logo and name — a CoreOTC
 * employee opening a guest link should see CoreOTC, not us. Falls back to the Outcome mark
 * on the main instance, and on any space that hasn't uploaded one.
 */
import { useEffect, useState } from "react";
import { Logo } from "@components/Logo";
import { loadSpace, spaceInfo, type SpaceInfo } from "@lib/space";

/** Space branding for the current host, or null on the main instance. */
export function useSpaceBrand(): SpaceInfo | null {
  const [brand, setBrand] = useState<SpaceInfo | null>(() => {
    const s = spaceInfo();
    return s && !s.is_root ? s : null;
  });
  useEffect(() => {
    void loadSpace().then((s) => setBrand(s && !s.is_root ? s : null));
  }, []);
  return brand;
}

export function BrandMark({ brand, width }: { brand: SpaceInfo | null; width: number }) {
  if (!brand?.icon) return <Logo width={width} />;
  return (
    <img
      className="oc-logo"
      src={brand.icon}
      width={width}
      height={width}
      alt={brand.name}
      draggable={false}
      style={{ objectFit: "contain" }}
    />
  );
}
