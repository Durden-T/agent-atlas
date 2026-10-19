import { useEffect, useState } from 'react';
import type { Folder, FolderCommand } from '../shared/contracts.ts';
import { FOLDER_LIMIT } from '../shared/contracts.ts';

function FolderRow({
  folder,
  busy,
  onChange,
}: {
  folder: Folder;
  busy: boolean;
  onChange: (command: FolderCommand) => Promise<boolean>;
}) {
  const [name, setName] = useState(folder.name),
    [deleting, setDeleting] = useState(false);
  useEffect(() => setName(folder.name), [folder.name]);
  return (
    <div className="folder-row">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onChange({ kind: 'rename', id: folder.id, name });
        }}
      >
        <input
          disabled={busy}
          aria-label={'收藏夹名称 ' + folder.name}
          value={name}
          maxLength={80}
          required
          onChange={(e) => setName(e.target.value)}
        />
        <button
          disabled={busy || name.trim() === folder.name}
          aria-label={'重命名收藏夹 ' + folder.name}
        >
          改名
        </button>
        <button
          type="button"
          disabled={busy}
          aria-label={'删除收藏夹 ' + folder.name}
          onClick={() => setDeleting(!deleting)}
        >
          删除
        </button>
      </form>
      {deleting && (
        <div className="folder-delete">
          <p>删除“{folder.name}”收藏夹？项目和判断记录保留。</p>
          <button disabled={busy} onClick={() => void onChange({ kind: 'delete', id: folder.id })}>
            确认删除
          </button>
          <button disabled={busy} onClick={() => setDeleting(false)}>
            取消
          </button>
        </div>
      )}
    </div>
  );
}
export function FolderManager({
  folders,
  busy,
  onChange,
}: {
  folders: Folder[];
  busy: boolean;
  onChange: (command: FolderCommand) => Promise<boolean>;
}) {
  const [name, setName] = useState('');
  return (
    <details className="folder-manager">
      <summary>
        管理收藏夹 <span className="muted">{folders.length}</span>
      </summary>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (await onChange({ kind: 'create', name })) setName('');
        }}
      >
        <label>
          新收藏夹名称
          <input
            disabled={busy}
            value={name}
            maxLength={80}
            required
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button disabled={busy || folders.length >= FOLDER_LIMIT}>创建收藏夹</button>
      </form>
      {!folders.length && <p className="small muted">创建收藏夹后，在项目详情中加入。</p>}
      {folders.map((folder) => (
        <FolderRow key={folder.id} folder={folder} busy={busy} onChange={onChange} />
      ))}
    </details>
  );
}
