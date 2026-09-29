import { Progress } from "../ui";
import "./page-loading.css";

/**
 * What the shell shows while a page's code arrives (M33.14): the kit's moving bar, named for the
 * page, where the page will be. Every page is its own chunk, so this shows once per page and only
 * for as long as the fetch takes.
 */
export function PageLoading({ name }: { name: string }) {
  return (
    <div className="page-loading-view" role="status">
      <Progress label={`Opening ${name}`} />
    </div>
  );
}
