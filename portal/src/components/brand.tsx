import { Icon } from "./icon";

export function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark"><Icon name="helmet" /></span>
      <span>Hard Hat<span className="brand-caption">Fleet workspace</span></span>
    </div>
  );
}
