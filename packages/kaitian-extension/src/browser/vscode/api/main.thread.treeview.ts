import { IRPCProtocol } from '@ali/ide-connection';
import { Injectable, Autowired, INJECTOR_TOKEN, Injector, Optinal } from '@ali/common-di';
import { TreeViewItem, TreeViewBaseOptions, ITreeViewRevealOptions } from '../../../common/vscode';
import { TreeItemCollapsibleState } from '../../../common/vscode/ext-types';
import { IMainThreadTreeView, IExtHostTreeView, ExtHostAPIIdentifier } from '../../../common/vscode';
import { Emitter, DisposableStore, toDisposable, isUndefined, CommandRegistry, localize } from '@ali/ide-core-browser';
import { IMainLayoutService } from '@ali/ide-main-layout';
import { ExtensionTabBarTreeView } from '../../components';
import { IIconService, IconType } from '@ali/ide-theme';
import { ExtensionTreeViewModel } from './tree-view/tree-view.model.service';
import { ExtensionCompositeTreeNode, ExtensionTreeRoot, ExtensionTreeNode } from './tree-view/tree-view.node.defined';
import { Tree, ITreeNodeOrCompositeTreeNode } from '@ali/ide-components';
import { IMenuRegistry, MenuId } from '@ali/ide-core-browser/lib/menu/next';
import { getTreeViewCollapseAllCommand } from './tree-view/util';

@Injectable({multiple: true})
export class MainThreadTreeView implements IMainThreadTreeView {
  private readonly proxy: IExtHostTreeView;

  @Autowired(IMainLayoutService)
  private readonly mainLayoutService: IMainLayoutService;

  @Autowired(IIconService)
  private readonly iconService: IIconService;

  @Autowired(IMenuRegistry)
  private readonly menuRegistry: IMenuRegistry;

  @Autowired(CommandRegistry)
  private readonly commandRegistry: CommandRegistry;

  @Autowired(INJECTOR_TOKEN)
  private readonly injector: Injector;

  // readonly dataProviders: Map<string, TreeViewDataProvider> = new Map<string, TreeViewDataProvider>();
  readonly treeModels: Map<string, ExtensionTreeViewModel> = new Map<string, ExtensionTreeViewModel>();

  private disposableCollection: Map<string, DisposableStore> = new Map();
  private disposable: DisposableStore = new DisposableStore();

  constructor(@Optinal(IRPCProtocol) private rpcProtocol: IRPCProtocol) {
    this.proxy = this.rpcProtocol.getProxy(ExtHostAPIIdentifier.ExtHostTreeView);
    this.disposable.add(toDisposable(() => this.treeModels.clear()));
  }

  dispose() {
    this.disposable.dispose();
  }

  createTreeModel(treeViewId: string, dataProvider: TreeViewDataProvider, options: TreeViewBaseOptions): ExtensionTreeViewModel {
    return ExtensionTreeViewModel.createModel(this.injector, dataProvider, treeViewId, options || {});
  }

  $registerTreeDataProvider(treeViewId: string, options: TreeViewBaseOptions): void {
    if (!this.treeModels.has(treeViewId)) {
      const disposable = new DisposableStore();
      const dataProvider = new TreeViewDataProvider(treeViewId, this.proxy, this.iconService);
      const model = this.createTreeModel(treeViewId, dataProvider, options);
      this.treeModels.set(treeViewId, model);
      disposable.add(toDisposable(() => this.treeModels.delete(treeViewId)));
      this.mainLayoutService.replaceViewComponent({
        id: treeViewId,
        component: ExtensionTabBarTreeView,
      }, {
        model,
        treeViewId,
      });

      const treeViewCollapseAllCommand = getTreeViewCollapseAllCommand(treeViewId);
      disposable.add(
        this.commandRegistry.registerCommand(treeViewCollapseAllCommand),
      );
      disposable.add(
        this.menuRegistry.registerMenuItem(MenuId.ViewTitle, {
          command: {
            id: treeViewCollapseAllCommand.id,
            label: localize('treeview.command.action.collapse'),
          },
          when: `view == ${treeViewId}`,
          group: 'navigation',
          order: 10000, // keep the last position
        }),
      );
      disposable.add(model.onDidSelectedNodeChange((treeItemIds: string[]) => {
        dataProvider.setSelection(treeViewId, treeItemIds);
      }));
      disposable.add(model.onDidChangeExpansionState((state: {treeItemId: string, expanded: boolean}) => {
        const { treeItemId, expanded } = state;
        dataProvider.setExpanded(treeViewId, treeItemId, expanded);
      }));
      const handler = this.mainLayoutService.getTabbarHandler(treeViewId);
      if (handler) {
        disposable.add(handler.onActivate(() => {
          dataProvider.setVisible(treeViewId, true);
        }));
        disposable.add(handler.onInActivate(() => {
          dataProvider.setVisible(treeViewId, false);
        }));
        disposable.add(disposable.add(toDisposable(() => handler.disposeView(treeViewId))));
      }
      this.disposableCollection.set(treeViewId, disposable);
    }
  }

  $unregisterTreeDataProvider(treeViewId: string) {
    const disposable = this.disposableCollection.get(treeViewId);
    if (disposable) {
      disposable.dispose();
    }
  }

  $refresh(treeViewId: string, itemsToRefresh?: TreeViewItem) {
    const treeModel = this.treeModels.get(treeViewId);
    if (treeModel) {
      treeModel.refresh(itemsToRefresh);
    }
  }

  async $reveal(treeViewId: string, treeItemId: string, options?: ITreeViewRevealOptions) {
    this.mainLayoutService.revealView(treeViewId);
    const treeModel = this.treeModels.get(treeViewId);
    if (treeModel) {
      treeModel.reveal(treeItemId, options);
    }
  }
}

export class TreeViewDataProvider extends Tree {

  private onTreeDataChangedEmitter = new Emitter<any>();
  private onRevealChangedEmitter = new Emitter<any>();

  private treeItemId2TreeNode: Map<string, ExtensionTreeNode | ExtensionCompositeTreeNode | ExtensionTreeRoot> = new Map();

  constructor(
    public readonly treeViewId: string,
    private readonly proxy: IExtHostTreeView,
    private readonly iconService: IIconService,
  ) {
    super();
  }

  get onTreeDataChanged() {
    return this.onTreeDataChangedEmitter.event;
  }

  get onRevealChanged() {
    return this.onRevealChangedEmitter.event;
  }

  get root() {
    return this._root;
  }

  public getTreeNodeIdByTreeItemId(treeItemId: string) {
    return this.treeItemId2TreeNode.get(treeItemId)?.id;
  }

  async createFoldNode(item: TreeViewItem, parent: ExtensionCompositeTreeNode): Promise<ExtensionCompositeTreeNode> {
    const expanded = TreeItemCollapsibleState.Expanded === item.collapsibleState;
    const icon = await this.toIconClass(item);
    const node = new ExtensionCompositeTreeNode(
      this,
      parent,
      item.label,
      item.description,
      icon,
      item.tooltip,
      item.command,
      item.contextValue || '',
      item.id,
      expanded,
    );
    return node;
  }

  async createNormalNode(item: TreeViewItem, parent: ExtensionCompositeTreeNode): Promise<ExtensionTreeNode> {
    const icon = await this.toIconClass(item);
    const node = new ExtensionTreeNode(
      this,
      parent,
      item.label,
      item.description,
      icon,
      item.tooltip,
      item.command,
      item.contextValue || '',
      item.id,
    );
    return node;
  }

  async toIconClass(item: TreeViewItem): Promise<string | undefined> {
    if (item.iconUrl || item.icon) {
      return this.iconService.fromIcon('', item.iconUrl || item.icon, IconType.Background);
    } else {
      return '';
    }
  }

  /**
   * 创建节点
   *
   * @param item tree view item from the ext
   */
  async createTreeNode(item: TreeViewItem, parent: ExtensionCompositeTreeNode): Promise<ExtensionCompositeTreeNode | ExtensionTreeNode> {
    if (!isUndefined(item.collapsibleState) && item.collapsibleState !== TreeItemCollapsibleState.None) {
      return await this.createFoldNode(item, parent);
    }
    return await this.createNormalNode(item, parent);
  }

  async resolveChildren(parent?: ExtensionCompositeTreeNode): Promise<(ExtensionCompositeTreeNode | ExtensionTreeRoot | ExtensionTreeNode)[]> {
    let nodes: (ExtensionCompositeTreeNode | ExtensionTreeRoot | ExtensionTreeNode)[] = [];
    if (parent) {
      let children: TreeViewItem[] | undefined;
      if (ExtensionTreeRoot.is(parent)) {
        children = await this.proxy.$getChildren(this.treeViewId);
      } else {
        children = await this.proxy.$getChildren(this.treeViewId, parent.treeItemId);
      }
      if (children && Array.isArray(children)) {
        for (const child of children) {
          const node = await this.createTreeNode(child, parent);
          nodes.push(node);
        }
      }
    } else {
      nodes = [new ExtensionTreeRoot(this as any, this.treeViewId)];
    }
    this.cacheNodes(nodes);
    return nodes;
  }

  // 按照默认次序排序
  sortComparator(a: ITreeNodeOrCompositeTreeNode, b: ITreeNodeOrCompositeTreeNode) {
    if (!a) {
      return 1;
    }
    if (!b) {
      return -1;
    }
    return 0;
  }

  getNodeByTreeItemId(treeItemId: string) {
    return this.treeItemId2TreeNode.get(treeItemId);
  }

  cacheNodes(nodes: (ExtensionCompositeTreeNode | ExtensionTreeRoot | ExtensionTreeNode)[]) {
    nodes.forEach((node) => {
      this.treeItemId2TreeNode.set(node.treeItemId, node);
    });
  }

  async refresh(itemsToRefresh?: TreeViewItem) {
    await this.onTreeDataChangedEmitter.fire(itemsToRefresh);
  }

  async reveal(viewItemId?: any) {
    await this.onRevealChangedEmitter.fire(viewItemId);
  }

  async setSelection(treeViewId: string, id: string[]) {
    this.proxy.$setSelection(treeViewId, id);
  }

  async setExpanded(treeViewId: string, id: any, expanded: boolean) {
    this.proxy.$setExpanded(treeViewId, id, expanded);
  }

  async setVisible(treeViewId: string, visible: boolean) {
    this.proxy.$setVisible(treeViewId, visible);
  }

  dispose() {
    super.dispose();
    this.treeItemId2TreeNode.clear();
  }
}
