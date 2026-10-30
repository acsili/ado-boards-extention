(() => {
  'use strict';

  const SYNC_INTERVAL_MS = 20 * 1000;   // как часто сверяться с сервером
  const RENDER_DELAY_MS = 100;          // пауза, чтобы пачку изменений отрисовать один раз
  const MAX_IDS_PER_REQUEST = 200;      // ограничение REST API на число id в одном запросе

  const CHECKLIST_ROW = '.work-item-list-container .work-item';
  const ROW_TITLE = '.work-item-title-container';
  const AVATAR_CLASS = 'cc-avatar';
  const ROW_WITH_AVATAR_CLASS = 'cc-has-avatar';
  const TOOLTIP_ASSIGNEE_CLASS = 'cc-tooltip-assignee';

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
   * Аватар стоит в строке между иконкой типа задачи и заголовком.
   * Заголовок сужается на ширину аватара с отступами: у TFS он calc(100% - 67px), аватар занимает ещё 24px.
   */
  function addStyles() {
    const style = document.createElement('style');
    style.textContent = `
      ${CHECKLIST_ROW} .${AVATAR_CLASS} {
        display: inline-block; vertical-align: top; margin: 1px 4px 0 2px;
        width: 18px; height: 18px; border-radius: 50%;
      }
      ${CHECKLIST_ROW}.${ROW_WITH_AVATAR_CLASS} ${ROW_TITLE} {
        max-width: calc(100% - 91px);
      }
      .${TOOLTIP_ASSIGNEE_CLASS} { opacity: .75; margin-top: 2px; }
    `;
    document.head.appendChild(style);
  }

  /**
   * Следит за изменениями доски (раскрыли чеклист, перетащили карточку, сменили фильтр)
   * и перерисовывает аватары. Изменения, которые вносит сам скрипт, пропускаются.
   */
  function observeBoard() {
    new MutationObserver(mutations => {
      const onlyOwnChanges = mutations.every(m =>
        [...m.addedNodes, ...m.removedNodes].every(node => node.classList?.contains(AVATAR_CLASS)));
      if (!onlyOwnChanges) scheduleRender();
    }).observe(document.body, { childList: true, subtree: true });
  }

  /** Откладывает перерисовку на RENDER_DELAY_MS; повторные вызовы за это время сливаются в один. */
  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, RENDER_DELAY_MS);
  }

  /** Обновляет аватары у всех строк раскрытых чеклистов. */
  function render() {
    extendRowTooltip();
    const incompleteIds = [];
    for (const { row, task } of checklistRows()) {
      watchTaskChanges(task);
      const id = task.id();
      const assignee = currentAssignee(task);
      if (assignee && !avatarUrl(assignee)) {
        // Модель неполная: прежний аватар не трогаем, данные берём с сервера.
        incompleteIds.push(id);
      } else {
        showAvatar(row, assignee);
      }
    }
    if (incompleteIds.length) syncWithServer(incompleteIds);
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
    const name = assignee.displayName || '';
    const login = assignee.uniqueName || '';
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
    if (assignee?.descriptor) return `${collectionUrl()}/_apis/GraphProfile/MemberAvatars/${assignee.descriptor}`;
    return assignee?.imageUrl || assignee?._links?.avatar?.href || null;
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
    if (!img) {
      img = document.createElement('img');
      img.className = AVATAR_CLASS;
      row.insertBefore(img, row.querySelector(ROW_TITLE));
      row.classList.add(ROW_WITH_AVATAR_CLASS);
    }
    const url = avatarUrl(assignee);
    if (img.getAttribute('src') !== url) img.src = url;
    img.title = img.alt = assignee.displayName;
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

  /** Сверяет с сервером исполнителей всех задач в раскрытых чеклистах. Только на видимой вкладке. */
  function syncAllWithServer() {
    if (!document.hidden) syncWithServer(checklistRows().map(({ task }) => task.id()));
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
      const modelAssignees = new Map(checklistRows().map(({ task }) => [task.id(), assigneeFromModel(task)]));
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
      .map(w => [w.id, w.fields['System.AssignedTo'] || null]));
  }
})();
