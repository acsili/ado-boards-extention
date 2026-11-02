(() => {
  'use strict';

  const SYNC_INTERVAL_MS = 20 * 1000;   // как часто сверяться с сервером
  const RENDER_DELAY_MS = 50;           // пауза для отложенных изменений (фоновые обновления)
  const MAX_IDS_PER_REQUEST = 200;      // ограничение REST API на число id в одном запросе

  const CHECKLIST_ROW = '.work-item-list-container .work-item';
  const ROW_TITLE = '.work-item-title-container';
  const AVATAR_CLASS = 'cc-avatar';
  const ROW_WITH_AVATAR_CLASS = 'cc-has-avatar';
  const TOOLTIP_ASSIGNEE_CLASS = 'cc-tooltip-assignee';

  const BADGE_AVATARS_CLASS = 'cc-badge-avatars';
  const BADGE_AVATAR_CLASS = 'cc-badge-avatar';

  /** id задачи -> исполнитель с сервера. Заполняется, только когда модели доверять нельзя. */
  const serverAssignees = new Map();
  /** id задач, запрос по которым уже отправлен и ещё не вернулся. */
  const requestedIds = new Set();
  /** Модели задач, у которых уже перехвачено событие изменения. */
  const watchedTasks = new WeakSet();

  let renderTimer;
  let tooltipExtended = false;

  addStyles();
  observeBoard();
  setInterval(syncAllWithServer, SYNC_INTERVAL_MS);
  document.addEventListener('visibilitychange', syncAllWithServer);
  render();

  /**
   * Стили аватарок в раскрытом чеклисте и в бейджах свернутых карточек.
   * Заголовок сужается на ширину аватара с отступами: у TFS он calc(100% - 67px), аватар занимает ещё 26px.
   */
  function addStyles() {
    const style = document.createElement('style');
    style.textContent = `
      ${CHECKLIST_ROW} .${AVATAR_CLASS} {
        display: inline-block; vertical-align: top; margin: 0 4px 0 -4px;
        width: 20px; height: 20px; border-radius: 50%;
      }
      ${CHECKLIST_ROW}.${ROW_WITH_AVATAR_CLASS} ${ROW_TITLE} {
        max-width: calc(100% - 93px);
      }
      .${TOOLTIP_ASSIGNEE_CLASS} { opacity: .75; margin-top: 2px; }

      .${BADGE_AVATARS_CLASS} {
        display: inline-flex; align-items: center; margin-left: -4px; margin-top: -8px; gap: 3px;
      }
      .${BADGE_AVATAR_CLASS} {
        width: 20px; height: 20px; border-radius: 50%; object-fit: cover;
        flex-shrink: 0; display: inline-block; vertical-align: middle;
      }
      .child-work-items-summary[aria-expanded="true"] ~ .${BADGE_AVATARS_CLASS} {
        display: none;
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Следит за изменениями доски (раскрыли чеклист, перетащили карточку, сменили фильтр)
   * и перерисовывает аватары. Изменения, которые вносит сам скрипт, пропускаются.
   */
  function observeBoard() {
    const isOwnNode = node => node.classList?.contains(AVATAR_CLASS)
      || node.classList?.contains(BADGE_AVATARS_CLASS)
      || node.classList?.contains(BADGE_AVATAR_CLASS);

    const isChecklistNode = node => node.nodeType === 1 && (
      node.matches?.('.work-item') ||
      node.querySelector?.('.work-item') ||
      node.classList?.contains('work-item-list-container')
    );

    new MutationObserver(mutations => {
      const onlyOwnChanges = mutations.every(m =>
        [...m.addedNodes, ...m.removedNodes].every(isOwnNode));
      if (onlyOwnChanges) return;

      const hasChecklistRows = mutations.some(m =>
        [...m.addedNodes].some(isChecklistNode));

      if (hasChecklistRows) {
        // Отрисовываем сразу синхронно в микротаске до первого paint браузера,
        // чтобы аватар уже стоял в DOM и текст строки не скакал при раскрытии.
        render();
      }
      scheduleRender();
    }).observe(document.body, { childList: true, subtree: true });
  }

  /** Откладывает перерисовку на RENDER_DELAY_MS; повторные вызовы за это время сливаются в один. */
  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, RENDER_DELAY_MS);
  }

  /** Обновляет аватары у всех строк раскрытых чеклистов и у свернутых бейджей карточек. */
  function render() {
    extendRowTooltip();
    const incompleteIds = [
      ...renderChecklistRows(),
      ...renderChecklistBadges(),
    ];
    if (incompleteIds.length) syncWithServer(incompleteIds);
  }

  /** Отрисовывает аватары в строках раскрытых чеклистов. Возвращает id задач с неполными моделями. */
  function renderChecklistRows() {
    const incompleteIds = [];
    for (const { row, task } of checklistRows()) {
      watchTaskChanges(task);
      const assignee = currentAssignee(task);
      if (assignee && !avatarUrl(assignee)) {
        incompleteIds.push(task.id());
      } else {
        showAvatar(row, assignee);
      }
    }
    return incompleteIds;
  }

  /** Отрисовывает аватары у свернутых бейджей карточек. Возвращает id задач с неполными моделями. */
  function renderChecklistBadges() {
    const incompleteIds = [];
    for (const { badge, children } of checklistBadges()) {
      const uniqueAssignees = [];
      const seen = new Set();
      for (const task of children) {
        watchTaskChanges(task);
        const assignee = currentAssignee(task);
        if (assignee && !avatarUrl(assignee)) {
          incompleteIds.push(task.id());
        } else if (assignee) {
          const key = assignee.uniqueName || assignee.displayName || assignee;
          if (!seen.has(key)) {
            seen.add(key);
            uniqueAssignees.push(assignee);
          }
        }
      }
      showBadgeAvatars(badge, uniqueAssignees);
    }
    return incompleteIds;
  }

  /**
   * Строки раскрытых чеклистов вместе с моделями задач.
   * Чеклист TFS построен на Knockout, модель строки достаётся через ko.dataFor().
   * @returns {{ row: HTMLElement, task: object }[]}
   */
  function checklistRows() {
    let ko;
    try { ko = window.require('knockout'); } catch { return []; }
    return [...document.querySelectorAll(CHECKLIST_ROW)]
      .map(row => ({ row, task: ko.dataFor(row)?.item }))
      .filter(({ task }) => task && task.id() > 0);
  }

  /**
   * Бейджи чеклистов на карточках доски (Task / Bug) вместе со списком дочерних задач.
   * Модель карточки TFS доступна через $.data('tfsEnhancements')[0]._item.
   * @returns {{ badge: HTMLElement, children: object[] }[]}
   */
  function checklistBadges() {
    let $;
    try { $ = window.jQuery || window.$ || window.require('jquery'); } catch { return []; }
    if (!$) return [];

    const results = [];
    for (const card of document.querySelectorAll('.board-tile')) {
      const children = $(card).data('tfsEnhancements')?.[0]?._item?.children?.();
      if (!children?.length) continue;

      for (const badge of card.querySelectorAll('.checklist-badge')) {
        const summary = badge.querySelector('.child-work-items-summary');
        if (!summary) continue;

        const iconType = summary.querySelector('.work-item-type-icon')?.getAttribute('aria-label');
        const matching = iconType
          ? children.filter(c => (typeof c.type === 'function' ? c.type() : c.type) === iconType)
          : children;

        if (matching.length) results.push({ badge, children: matching });
      }
    }
    return results;
  }

  /**
   * Все известные задачи (из раскрытых строк и из свернутых карточек).
   * @returns {Map<number, object>} id -> модель задачи
   */
  function allKnownTasks() {
    const map = new Map();
    for (const { task } of checklistRows()) map.set(task.id(), task);
    for (const { children } of checklistBadges()) {
      for (const ch of children) map.set(ch.id(), ch);
    }
    return map;
  }

  /** Исполнитель задачи: с сервера, если модели доверять нельзя, иначе из модели. */
  function currentAssignee(task) {
    const id = task.id();
    return serverAssignees.has(id) ? serverAssignees.get(id) : assigneeFromModel(task);
  }

  /**
   * Дописывает исполнителя и его логин в штатный хинт строки чеклиста (RichContentTooltip TFS).
   * TFS заново заполняет хинт при каждом показе в _initializeContent, его и подменяем.
   * Модуль хинтов может загрузиться позже скрипта, поэтому вызывается из render() до успеха.
   */
  function extendRowTooltip() {
    if (tooltipExtended) return;
    let tooltip;
    try { tooltip = window.require('VSS/Controls/PopupContent').RichContentTooltip; } catch { return; }
    if (typeof tooltip?.prototype._initializeContent !== 'function') return;
    tooltipExtended = true;

    const initializeContent = tooltip.prototype._initializeContent;
    tooltip.prototype._initializeContent = function (...args) {
      const row = this._$dropElement?.[0];
      const task = row?.matches?.(CHECKLIST_ROW) && window.require('knockout').dataFor(row)?.item;
      const assignee = task && currentAssignee(task);
      if (!assignee) return initializeContent.apply(this, args);

      const content = document.createElement('div');
      content.append(typeof this._options.text === 'string' ? this._options.text : task.fieldValue('System.Title'));
      const assigneeLine = document.createElement('div');
      assigneeLine.className = TOOLTIP_ASSIGNEE_CLASS;
      assigneeLine.textContent = assigneeLabel(assignee);
      content.append(assigneeLine);
      this._setContent(content);
    };
  }

  /**
   * ФИО и логин исполнителя, например "Иванов Иван (Ivanov_II)".
   * В displayName TFS логин обычно уже есть в скобках — тогда полный логин с доменом не дублируется.
   */
  function assigneeLabel(assignee) {
    if (typeof assignee === 'string') return assignee;
    const name = assignee?.displayName || '';
    const login = assignee?.uniqueName || '';
    const shortLogin = login.split('\\').pop();
    return !login || name.includes(shortLogin) ? name : `${name} (${login})`;
  }

  /**
   * Исполнитель задачи по данным модели доски.
   * @returns {object|null} identity из поля System.AssignedTo; null — задача не назначена.
   */
  function assigneeFromModel(task) {
    try { return task.fieldValue('System.AssignedTo') || null; } catch { return null; }
  }

  /**
   * Адрес картинки исполнителя. По возможности строится из descriptor, а не берётся готовым:
   * у одного человека по разным адресам TFS бывают разные картинки, и аватар «прыгал» бы.
   * @returns {string|null} null — в identity нет данных для картинки (неполная модель).
   */
  function avatarUrl(assignee) {
    if (!assignee || typeof assignee !== 'object') return null;
    if (assignee.descriptor) return `${collectionUrl()}/_apis/GraphProfile/MemberAvatars/${assignee.descriptor}`;
    return assignee.imageUrl || assignee._links?.avatar?.href || null;
  }

  /** Адрес коллекции TFS из текущего URL, например "/IS-Builder8". */
  function collectionUrl() {
    return '/' + location.pathname.split('/')[1];
  }

  /**
   * Показывает аватар исполнителя в строке чеклиста или убирает его, если задача не назначена.
   * @param {HTMLElement} row строка чеклиста
   * @param {object|null} assignee identity исполнителя
   */
  function showAvatar(row, assignee) {
    let img = row.querySelector(`:scope > .${AVATAR_CLASS}`);
    if (!assignee) {
      img?.remove();
      row.classList.remove(ROW_WITH_AVATAR_CLASS);
      return;
    }
    const url = avatarUrl(assignee);
    if (!img) {
      img = document.createElement('img');
      img.className = AVATAR_CLASS;
      if (url) img.src = url;
      img.title = img.alt = assignee.displayName || '';
      row.insertBefore(img, row.querySelector(ROW_TITLE));
      row.classList.add(ROW_WITH_AVATAR_CLASS);
      return;
    }
    if (img.getAttribute('src') !== url) img.src = url;
    img.title = img.alt = assignee.displayName || '';
  }

  /**
   * Отображает аватарки исполнителей рядом со счетчиком свернутого бейджа чеклиста (Task / Bug).
   * @param {HTMLElement} badge контейнер бейджа .checklist-badge
   * @param {object[]} assignees список уникальных исполнителей
   */
  function showBadgeAvatars(badge, assignees) {
    let container = badge.querySelector(`:scope > .${BADGE_AVATARS_CLASS}`);
    if (!assignees?.length) {
      container?.remove();
      return;
    }
    if (!container) {
      container = document.createElement('span');
      container.className = BADGE_AVATARS_CLASS;
      badge.appendChild(container);
    }

    const urls = assignees.map(avatarUrl).filter(Boolean);
    const currentUrls = [...container.children].map(img => img.getAttribute('src'));
    if (urls.length === currentUrls.length && urls.every((u, i) => u === currentUrls[i])) return;

    container.replaceChildren();
    for (const assignee of assignees) {
      const url = avatarUrl(assignee);
      if (!url) continue;

      const img = document.createElement('img');
      img.className = BADGE_AVATAR_CLASS;
      img.src = url;
      img.title = assigneeLabel(assignee);
      img.alt = assignee.displayName || '';
      container.appendChild(img);
    }
  }

  /**
   * Перехватывает событие изменения задачи в модели доски. Когда задачу правят в форме,
   * открытой с доски, аватар перерисовывается сразу, а устаревшие данные сервера забываются.
   */
  function watchTaskChanges(task) {
    if (watchedTasks.has(task) || typeof task._raiseItemChanged !== 'function') return;
    watchedTasks.add(task);
    const raiseItemChanged = task._raiseItemChanged;
    task._raiseItemChanged = function (...args) {
      const result = raiseItemChanged.apply(this, args);
      serverAssignees.delete(this.id());
      scheduleRender();
      return result;
    };
  }

  /** Сверяет с сервером исполнителей всех видимых задач. Только на активной вкладке. */
  function syncAllWithServer() {
    if (document.hidden) return;
    const ids = [...allKnownTasks().keys()];
    if (ids.length) syncWithServer(ids);
  }

  /**
   * Запрашивает исполнителей с сервера и запоминает тех, для кого модели доверять нельзя.
   * Модели доверяем, только если в ней полный identity и он совпадает с сервером.
   * @param {number[]} ids id задач
   */
  async function syncWithServer(ids) {
    ids = [...new Set(ids)].filter(id => !requestedIds.has(id));
    if (!ids.length) return;
    ids.forEach(id => requestedIds.add(id));
    try {
      const known = allKnownTasks();
      const modelAssignees = new Map([...known.entries()].map(([id, task]) => [id, assigneeFromModel(task)]));
      for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
        const fetched = await fetchAssignees(ids.slice(i, i + MAX_IDS_PER_REQUEST));
        for (const [id, fromServer] of fetched) {
          const fromModel = modelAssignees.get(id);
          const sameAssignee = (fromServer?.uniqueName ?? null) === (fromModel?.uniqueName ?? null);
          const modelIsComplete = !fromModel || avatarUrl(fromModel);
          if (sameAssignee && modelIsComplete) serverAssignees.delete(id);
          else serverAssignees.set(id, fromServer);
        }
      }
      render();
    } catch (e) {
      console.warn('[cc-avatars]', e);
    } finally {
      ids.forEach(id => requestedIds.delete(id));
    }
  }

  /**
   * Один запрос к REST API за полем System.AssignedTo.
   * Авторизация не нужна: запрос уходит со страницы TFS под учёткой пользователя.
   * @param {number[]} ids не больше MAX_IDS_PER_REQUEST
   * @returns {Promise<Map<number, object|null>>} id задачи -> исполнитель (null — не назначена)
   */
  async function fetchAssignees(ids) {
    const url = `${collectionUrl()}/_apis/wit/workitems?ids=${ids.join(',')}`
      + '&fields=System.AssignedTo&errorPolicy=omit&api-version=6.0';
    const response = await fetch(url).then(r => r.json());
    return new Map((response.value || [])
      .filter(Boolean)   // errorPolicy=omit: удалённые и недоступные задачи приходят как null
      .map(w => [w.id, w.fields?.['System.AssignedTo'] || null]));
  }
})();
