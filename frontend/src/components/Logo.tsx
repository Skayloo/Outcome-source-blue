/** Outcome brand mark — gradient tile with a chat bubble + outgoing arrow (public/logo.svg). */
export function Logo({ width = 70 }: { width?: number }) {
  return (
    <img
      src="/logo.svg"
      width={width}
      height={width}
      className="oc-logo"
      alt="Outcome"
      draggable={false}
      style={{ objectFit: "contain" }}
    />
  );
}
