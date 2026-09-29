/**
 * The schedules panel lives with Automations since M33.11 (src/pages/automations/SchedulesPanel.tsx),
 * rebuilt on the kit. System still draws it from here, with the same props, until System is
 * rebuilt and imports it from there (or leaves the schedules to Automations); then this goes.
 */
export { default, type SchedulesPanelProps } from "./pages/automations/SchedulesPanel";
