import { BUILTIN_GATES } from './define.ts';
import type { GateContext, GateDef, GateResult, Role, StageDef, StudioDefinition, TransitionDef } from './types.ts';

export function stage(def: StudioDefinition, id: string): StageDef {
  const s = def.workflow.stages.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown stage "${id}"`);
  return s;
}

export const initialStage = (def: StudioDefinition) => def.workflow.stages[0];
export const publishStage = (def: StudioDefinition) => def.workflow.stages.find((s) => s.publishes)!;

export function canEdit(def: StudioDefinition, stageId: string, roles: Role[]): boolean {
  const s = stage(def, stageId);
  if (!s.editable || s.publishes) return false;
  const allowed = s.editRoles ?? ['author', 'admin'];
  return roles.some((r) => allowed.includes(r));
}

export function gate(def: StudioDefinition, id: string): GateDef {
  const g = def.gates?.find((x) => x.id === id) ?? BUILTIN_GATES[id];
  if (!g) throw new Error(`Unknown gate "${id}"`);
  return g;
}

export interface TransitionView extends TransitionDef {
  allowedForActor: boolean;
  gateResults: Array<GateResult & { id: string; label: string }>;
  ready: boolean;
}

/** Every transition out of the current stage, with role checks and gate results evaluated. */
export function availableTransitions(def: StudioDefinition, stageId: string, roles: Role[], ctx: GateContext): TransitionView[] {
  return def.workflow.transitions
    .filter((t) => t.from === stageId)
    .map((t) => {
      const gateResults = (t.gates ?? []).map((id) => {
        const g = gate(def, id);
        let r: GateResult;
        try {
          r = g.check(ctx);
        } catch (e) {
          r = { ok: false, detail: `Gate failed to run: ${(e as Error).message}` };
        }
        return { id, label: g.label, ...r };
      });
      const allowedForActor = roles.some((r) => t.roles.includes(r));
      return { ...t, allowedForActor, gateResults, ready: allowedForActor && gateResults.every((g) => g.ok) };
    });
}
