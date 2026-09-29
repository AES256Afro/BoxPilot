import { useId, useState } from "react";
import { Button, Field, Notice, Select, Sheet, Tag, TextInput } from "../../ui";
import type { RiskTier } from "../../ui/types";
import { humanize, type Flow, type PaletteStep } from "./flows";

/*
 * Building an automation (M13.2), in a sheet over the page: a name, what it may run after, and its
 * steps from the palette, each with its own fields, what happens if it fails, and how many times
 * it is retried. Whatever is set is checked by the server when it is saved.
 */

interface DraftStep { operationId: string; onFailure: "stop" | "continue"; retry: number; parameters: Record<string, string> }

export interface FlowBuilderProps {
  palette: PaletteStep[];
  flows: Flow[];
  onClose: () => void;
  /** Saves the flow; throws with the server's words when it is refused. */
  onSave: (flow: { name: string; steps: Array<Record<string, unknown>>; triggerFlowId?: string }) => Promise<void>;
}

const tierOf = (risk: string): RiskTier | undefined => (risk === "low" || risk === "medium" || risk === "high" ? risk : undefined);

export function FlowBuilder({ palette, flows, onClose, onSave }: FlowBuilderProps) {
  const formId = useId();
  const [name, setName] = useState("");
  const [after, setAfter] = useState("");
  const [steps, setSteps] = useState<DraftStep[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const titleFor = (operationId: string) => palette.find((step) => step.operationId === operationId)?.title ?? operationId;
  const change = (index: number, update: (step: DraftStep) => DraftStep) => setSteps((current) => current.map((entry, at) => (at === index ? update(entry) : entry)));

  const save = async () => {
    if (saving) return;
    setError(null);
    setSaving(true);
    try {
      const built = steps.map((step) => {
        const fields = palette.find((entry) => entry.operationId === step.operationId)?.fields ?? [];
        const parameters: Record<string, unknown> = {};
        for (const field of fields) {
          const raw = step.parameters[field.name];
          if (raw === undefined || raw === "") continue; // an unset optional field is simply absent
          parameters[field.name] = field.type === "number" ? Number(raw) : field.type === "boolean" ? raw === "true" : raw;
        }
        return { operationId: step.operationId, parameters, ...(step.onFailure === "continue" ? { onFailure: "continue" as const } : {}), ...(step.retry > 0 ? { retry: step.retry } : {}) };
      });
      await onSave({ name, steps: built, ...(after ? { triggerFlowId: after } : {}) });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save the automation");
      setSaving(false);
    }
  };

  return (
    <Sheet
      kicker="New automation"
      title="Build your own"
      size="lg"
      onClose={onClose}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" form={formId} busy={saving} disabled={!name.trim() || steps.length === 0}>Save</Button>
      </>}
    >
      <form id={formId} className="automations-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        {error && <Notice tone="danger" live title="The automation was not saved">{error}</Notice>}
        <Field label="Automation name" hint="What it does, in your words.">
          <TextInput maxLength={80} value={name} onValueChange={setName} placeholder="Tidy up on Sunday nights" />
        </Field>
        {flows.length > 0 && (
          <Field label="Runs after" optional>
            <Select value={after} onValueChange={setAfter} options={[{ value: "", label: "Only when scheduled or run by hand" }, ...flows.map((other) => ({ value: other.id, label: `after ${other.name} completes` }))]} />
          </Field>
        )}
        <Field label="Add a step" hint="Each step runs as its own recorded job, in order. A step that fails stops the run unless it says to keep going.">
          <Select value="" placeholder="Pick an operation…" onValueChange={(chosen) => { if (chosen) setSteps((current) => [...current, { operationId: chosen, onFailure: "stop", retry: 0, parameters: {} }]); }}
            options={palette.map((step) => ({ value: step.operationId, label: `${step.title} (${step.risk})` }))} />
        </Field>
        {steps.length > 0 && (
          <ol className="automations-steps">
            {steps.map((step, index) => {
              const entry = palette.find((candidate) => candidate.operationId === step.operationId);
              const fields = entry?.fields ?? [];
              const tier = entry ? tierOf(entry.risk) : undefined;
              const setParam = (field: string, value: string) => change(index, (current) => ({ ...current, parameters: { ...current.parameters, [field]: value } }));
              return (
                <li key={`${step.operationId}-${index}`} className="automations-step">
                  <div className="automations-step__head">
                    <span className="automations-step__index">{index + 1}</span>
                    <strong className="automations-step__title">{titleFor(step.operationId)}</strong>
                    {tier && <Tag tier={tier} />}
                    <span className="automations-step__moves">
                      <Button variant="ghost" aria-label={`Move step ${index + 1} up`} disabled={index === 0} onClick={() => setSteps((current) => { const next = [...current]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; })}>Up</Button>
                      <Button variant="ghost" aria-label={`Remove step ${index + 1}`} onClick={() => setSteps((current) => current.filter((_, at) => at !== index))}>Remove</Button>
                    </span>
                  </div>
                  {fields.length > 0 && (
                    <div className="automations-step__fields">
                      {fields.map((field) => {
                        // A field with a fixed set of choices (a declared enum, or yes and no for a
                        // boolean) is one select; everything else is a text or number box.
                        const choices = field.enum ?? (field.type === "boolean" ? ["true", "false"] : null);
                        const label = `${humanize(field.name)} for step ${index + 1}`;
                        return (
                          <Field key={field.name} label={humanize(field.name)} required={!field.optional}>
                            {choices
                              ? <Select aria-label={label} value={step.parameters[field.name] ?? ""} placeholder="choose…" onValueChange={(value) => setParam(field.name, value)} options={choices.map((option) => ({ value: option, label: field.type === "boolean" ? (option === "true" ? "Yes" : "No") : option }))} />
                              : <TextInput aria-label={label} type={field.type === "number" ? "number" : "text"} mono value={step.parameters[field.name] ?? ""} onValueChange={(value) => setParam(field.name, value)} />}
                          </Field>
                        );
                      })}
                    </div>
                  )}
                  <div className="automations-step__policy">
                    <Field label="If it fails">
                      <Select aria-label={`If step ${index + 1} fails`} value={step.onFailure} onValueChange={(value) => change(index, (current) => ({ ...current, onFailure: value as DraftStep["onFailure"] }))}
                        options={[{ value: "stop", label: "Stop the run" }, { value: "continue", label: "Keep going" }]} />
                    </Field>
                    <Field label="Retry">
                      <Select aria-label={`Retries for step ${index + 1}`} value={String(step.retry)} onValueChange={(value) => change(index, (current) => ({ ...current, retry: Number(value) }))}
                        options={[0, 1, 2, 3].map((count) => ({ value: String(count), label: count === 0 ? "No retry" : `${count}×` }))} />
                    </Field>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </form>
    </Sheet>
  );
}
