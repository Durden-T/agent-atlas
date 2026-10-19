import { getRepository, transaction, type Database } from '../database.ts';
import {
  FOLDER_LIMIT,
  folderCommandSchema,
  personalSchema,
  type Folder,
  type FolderCommand,
  type PersonalUpdate,
} from '../../shared/contracts.ts';
import { AppError } from '../errors.ts';

export function createPersonal(db: Database) {
  function listFolders(): Folder[] {
    return db
      .prepare('SELECT id,name FROM folders ORDER BY name COLLATE NOCASE,id LIMIT ?')
      .all(FOLDER_LIMIT)
      .map((row) => ({ id: Number(row.id), name: String(row.name) }));
  }
  function changeFolder(input: FolderCommand): Folder | null {
    const command = folderCommandSchema.parse(input);
    return transaction(db, () => {
      if (
        command.kind !== 'create' &&
        !db.prepare('SELECT id FROM folders WHERE id=?').get(command.id)
      )
        throw new AppError('收藏夹不存在，请刷新', 'not_found', 404);
      if (command.kind === 'delete') {
        db.prepare('DELETE FROM folders WHERE id=?').run(command.id);
        db.prepare(
          "UPDATE settings SET data=json_set(data,'$.folderId',NULL) WHERE key='view' AND json_extract(data,'$.folderId')=?",
        ).run(command.id);
        return null;
      }
      const existing = db
        .prepare('SELECT id FROM folders WHERE name=? COLLATE NOCASE')
        .get(command.name);
      if (existing && (command.kind === 'create' || Number(existing.id) !== command.id))
        throw new AppError('同名收藏夹已存在');
      if (command.kind === 'rename') {
        db.prepare('UPDATE folders SET name=? WHERE id=?').run(command.name, command.id);
        return { id: command.id, name: command.name };
      }
      if (listFolders().length >= FOLDER_LIMIT) throw new AppError('收藏夹数量已达上限');
      const result = db.prepare('INSERT INTO folders(name) VALUES(?)').run(command.name);
      return { id: Number(result.lastInsertRowid), name: command.name };
    });
  }
  function setPersonal(id: number, input: PersonalUpdate): void {
    const value = personalSchema.parse(input);
    if (!getRepository(db, id)) throw new AppError('仓库记录不存在', 'not_found', 404);
    transaction(db, () => {
      if (value.folderIds) {
        for (const folderId of value.folderIds)
          if (!db.prepare('SELECT id FROM folders WHERE id=?').get(folderId))
            throw new AppError('收藏夹不存在，请刷新', 'not_found', 404);
        db.prepare('DELETE FROM repository_folders WHERE repository_id=?').run(id);
        const insert = db.prepare(
          'INSERT INTO repository_folders(repository_id,folder_id) VALUES(?,?)',
        );
        for (const folderId of value.folderIds) insert.run(id, folderId);
      }
      if (value.viewed !== undefined)
        db.prepare(
          'INSERT INTO personal_state(repository_id,viewed) VALUES(?,?) ON CONFLICT(repository_id) DO UPDATE SET viewed=excluded.viewed',
        ).run(id, value.viewed ? 1 : 0);
    });
  }
  return { listFolders, changeFolder, setPersonal };
}
