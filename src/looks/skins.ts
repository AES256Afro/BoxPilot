/*
 * Every look's skin, in the entry stylesheet (M41). A skin is scoped to :root[data-look="<id>"], so
 * only the chosen one applies; they ride in the first stylesheet so a page never paints in one look
 * and then jumps to another. Each look's Home is its own chunk (src/looks/LookHome.tsx) and brings
 * its own home.css with it.
 */
import "./fonts.css";
import "./looks.css";
import "./blend/skin.css";
import "./launcher/skin.css";
import "./console/skin.css";
import "./aqua/skin.css";
import "./blueprint/skin.css";
import "./phosphor/skin.css";
import "./rack/skin.css";
import "./swiss/skin.css";
import "./toybox/skin.css";
import "./cockpit/skin.css";
import "./eink/skin.css";
import "./quest/skin.css";
import "./transit/skin.css";
