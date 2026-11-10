import { Field, Select, TextInput } from "../../ui";

/*
 * How often, and when: the fields a schedule and an automation's schedule share. One operation on a
 * schedule (Schedules) and a flow on one (Your automations) take the same cadence from the server,
 * so they ask for it the same way.
 */

type Frequency = "hourly" | "daily" | "weekly";
/** The form's own state: the time as the browser's time box holds it ("03:00"). */
export interface CadenceDraft { frequency: Frequency; weekday: number; time: string }
/** What the server takes: the minute always, the hour unless hourly, the weekday only weekly. */
interface Cadence { frequency: Frequency; minute: number; hour: number | null; weekday: number | null }

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const startingCadence: CadenceDraft = { frequency: "daily", weekday: 0, time: "03:00" };

export function cadenceOf(draft: CadenceDraft): Cadence {
  const [hour, minute] = draft.time.split(":").map((part) => Number.parseInt(part, 10));
  return {
    frequency: draft.frequency,
    minute: Number.isInteger(minute) && minute >= 0 && minute <= 59 ? minute : 0,
    hour: draft.frequency === "hourly" ? null : Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 3,
    weekday: draft.frequency === "weekly" ? draft.weekday : null,
  };
}

export function CadenceFields({ value, onChange, serverTimezone = null }: { value: CadenceDraft; onChange: (next: CadenceDraft) => void; serverTimezone?: string | null }) {
  return (
    <>
      <Field label="How often">
        <Select value={value.frequency} onValueChange={(frequency) => onChange({ ...value, frequency: frequency as Frequency })} options={[{ value: "hourly", label: "Hourly" }, { value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" }]} />
      </Field>
      {value.frequency === "weekly" && (
        <Field label="Weekday">
          <Select value={String(value.weekday)} onValueChange={(weekday) => onChange({ ...value, weekday: Number(weekday) })} options={weekdays.map((day, index) => ({ value: String(index), label: day }))} />
        </Field>
      )}
      {value.frequency !== "hourly" ? (
        <Field label="Time of day" hint={serverTimezone ? `In the server's time zone, ${serverTimezone}.` : "In the server's time zone."}>
          <TextInput type="time" mono value={value.time} onValueChange={(time) => onChange({ ...value, time })} />
        </Field>
      ) : (
        <Field label="Minute of the hour">
          <TextInput mono inputMode="numeric" value={value.time.split(":")[1] ?? "0"} onValueChange={(minute) => onChange({ ...value, time: `00:${minute}` })} placeholder="minute" />
        </Field>
      )}
    </>
  );
}
