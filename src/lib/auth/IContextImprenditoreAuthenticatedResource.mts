import { TCommonHeaders } from '@axiumine/koa-utils/graphQL/schema/context/TCommonHeaders'
import { IRedisDataImprenditoreForNode } from '@thedoctorweb_agency/marketplace-common/others/Redis/IRedisDataImprenditoreForNode'
import { IncomingHttpHeaders } from 'http'

type IStateApi = {
	user: IRedisDataImprenditoreForNode
}
export type IContextImprenditoreAuthenticatedResource = {
	state: IStateApi
	request: {
		header?: TCommonHeaders & IncomingHttpHeaders
	}
}
export {}
