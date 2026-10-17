/**
 * Team information for the About page.
 *
 * Add real team members here. The About page renders a text-based
 * roster when entries exist, and a founder-led statement when empty.
 * Do not add placeholder people. Photos are optional — set `photo`
 * to a path under /public when available.
 *
 * Example:
 *   { name: "Full Name", role: "Founder & CEO", focus: "Systems engineering", photo: "/media/team/name.jpg" }
 */

export type TeamMember = {
  name: string;
  role: string;
  focus?: string;
  photo?: string;
  link?: string;
};

export const team: TeamMember[] = [];
