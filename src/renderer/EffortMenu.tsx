// BET-644 — the effort / variant listbox: the second adopter of the specced
// `Dropdown` surface (narrow width, no search) and of `MenuOption`. Split out
// of ModelPicker so the option row is a real shared primitive across two
// distinct menus.
//
// `OpencodeModel.variants` is `Array<{ id }>` today — there is no
// provider-supplied description — so the sub-lines are a static map keyed on
// the lower-cased variant id. A variant not in the map renders label-only at
// the 34px density (the density rule doing its job — we never invent copy for
// an unknown id). If a provider ever ships its own description, it wins.

import type { OpencodeModel } from "../shared/types";
import type { ModelSelection } from "./chatShared";
import { Dropdown } from "./MenuItem";
import { MenuOption } from "./MenuOption";
import { titleCase } from "./chatUtils";

const VARIANT_SUB: Record<string, string> = {
  default: "Let the model decide",
  low: "Fastest, least reasoning",
  high: "Slower, more thorough",
};

export function EffortMenu({
  variants,
  activeModel,
  activeVariantId,
  onSelect,
  onClose,
}: {
  variants: Array<{ id: string }>;
  activeModel: OpencodeModel | null;
  activeVariantId?: string;
  onSelect: (m: ModelSelection) => void;
  onClose: () => void;
}) {
  const base = activeModel
    ? { providerID: activeModel.providerID, modelID: activeModel.id }
    : null;

  const choose = (variantId: string | null) => {
    if (!base) return;
    onSelect(variantId ? { ...base, variant: variantId } : base);
    onClose();
  };

  return (
    <Dropdown
      hook="manta-effort-dropdown"
      role="listbox"
      placement="above"
      align="end"
      width="narrow"
    >
      <MenuOption
        selected={activeVariantId == null}
        label="Default"
        sub={VARIANT_SUB.default}
        onSelect={() => choose(null)}
      />
      {variants.map((v) => {
        const sub = VARIANT_SUB[String(v.id).toLowerCase()];
        return (
          <MenuOption
            key={v.id}
            selected={activeVariantId === v.id}
            label={titleCase(v.id)}
            sub={sub}
            onSelect={() => choose(v.id)}
          />
        );
      })}
    </Dropdown>
  );
}
