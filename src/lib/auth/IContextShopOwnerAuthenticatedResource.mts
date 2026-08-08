import { TCommonHeaders } from '@axiumine/koa-utils/graphQL/schema/context/TCommonHeaders'
import { IRedisDataShopOwnerForNode } from '@axiumine/marketplace-common/others/Redis/IRedisDataShopOwnerForNode'
import { IncomingHttpHeaders } from 'http'

type IStateApi = {
	user: IRedisDataShopOwnerForNode
}
export type IContextShopOwnerAuthenticatedResource = {
	state: IStateApi
	request: {
		header?: TCommonHeaders & IncomingHttpHeaders
	}
}
export {}
