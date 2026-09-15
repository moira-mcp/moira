/**
 * Note version history.
 *
 * The history interface itself is shared with playbooks and global settings; a note only says
 * where its revisions come from and what restoring one means. Restoring writes the old text as a
 * new version rather than rewinding, which is how the store behaves for every consumer.
 */

import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { apiClient } from "../../services/api-client";
import {
  RevisionHistoryDialog,
  type RevisionHistorySource,
} from "../history/RevisionHistoryDialog";

interface NoteHistoryDialogProps {
  open: boolean;
  onClose: (restored: boolean) => void;
  noteKey: string | null;
}

export const NoteHistoryDialog: React.FC<NoteHistoryDialogProps> = ({ open, onClose, noteKey }) => {
  const { t } = useTranslation();

  const source = useMemo<RevisionHistorySource | null>(() => {
    if (!noteKey) return null;
    return {
      label: t("pages.notes.history.subject", { key: noteKey, defaultValue: noteKey }),
      listRevisions: async () =>
        (await apiClient.getNoteHistory(noteKey)).map((version) => ({
          revision: version.version,
          size: version.size,
          preview: version.preview,
          createdAt: version.createdAt,
        })),
      readRevision: async (revision) => (await apiClient.getNote(noteKey, revision)).value,
      readCurrent: async () => (await apiClient.getNote(noteKey)).value,
      restore: async (revision) => {
        const [past, current] = await Promise.all([
          apiClient.getNote(noteKey, revision),
          apiClient.getNote(noteKey),
        ]);
        await apiClient.updateNote(noteKey, { value: past.value, tags: current.tags });
      },
    };
  }, [noteKey, t]);

  return <RevisionHistoryDialog open={open} onClose={onClose} source={source} />;
};
