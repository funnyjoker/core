import { Autowired, Injectable } from '@ali/common-di';
import * as fileIcons from 'file-icons-js';
import { URI } from '@ali/ide-core-common';
import { MaybePromise } from '@ali/ide-core-common/src/types';

export const FOLDER_ICON = 'fa fa-folder';
export const FILE_ICON = 'fa fa-file';

export const LabelProviderContribution = Symbol('LabelProviderContribution');
export interface LabelProviderContribution {

    /**
     * whether this contribution can handle the given element and with what priority.
     * All contributions are ordered by the returned number if greater than zero. The highest number wins.
     * If two or more contributions return the same positive number one of those will be used.
     * It is undefined which one.
     */
    canHandle(element: object): number;

    /**
     * returns an icon class for the given element.
     */
    getIcon?(element: object): MaybePromise<string>;

    /**
     * returns a short name for the given element.
     */
    getName?(element: object): string;

    /**
     * returns a long name for the given element.
     */
    getLongName?(element: object): string;

}

@Injectable()
export class DefaultUriLabelProviderContribution implements LabelProviderContribution {

    canHandle(uri: object): number {
        if (uri instanceof URI) {
            return 1;
        }
        return 0;
    }

    getIcon(uri: URI): MaybePromise<string> {
        const iconClass = this.getFileIcon(uri);
        if (!iconClass) {
            if (uri.displayName.indexOf('.') === -1) {
                return FOLDER_ICON;
            } else {
                return FILE_ICON;
            }
        }
        return iconClass;
    }

    getName(uri: URI): string {
        return uri.displayName;
    }

    getLongName(uri: URI): string {
        return uri.path.toString();
    }

    protected getFileIcon(uri: URI): string | undefined {
      return fileIcons.getClassWithColor(uri.displayName);
    }
}

@Injectable()
export class LabelProvider {
    @Autowired()
    public LabelProviderContribution: DefaultUriLabelProviderContribution;

    async getIcon(element: object): Promise<string> {
        const contribs = this.findContribution(element);
        const contrib = contribs.find((c) => c.getIcon !== undefined);
        if (!contrib) {
            return '';
        }
        return contrib.getIcon!(element);
    }

    getName(element: object): string {
        const contribs = this.findContribution(element);
        const contrib = contribs.find((c) => c.getName !== undefined);
        if (!contrib) {
            return '<unknown>';
        }
        return contrib.getName!(element);
    }

    getLongName(element: object): string {
        const contribs = this.findContribution(element);
        const contrib = contribs.find((c) => c.getLongName !== undefined);
        if (!contrib) {
            return '';
        }
        return contrib!.getLongName!(element);
    }

    protected findContribution(element: object): LabelProviderContribution[] {
        return [ this.LabelProviderContribution ];
    }

}
