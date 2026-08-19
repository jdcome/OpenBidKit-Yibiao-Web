// L4 runner 注册入口：把已移植的 runner 落入 taskService.registerRunner。
// 在 server boot（index.ts）创建 taskService 后调用一次。
// 随 runner 移植进度逐个 import + register；未注册的 type 仍走 start-* 的 501 兜底。
import type { TaskService } from '../service';
import { runRejectionItemsExtractionTask } from './rejection-items-extraction';
import { runRejectionCheckTask } from './rejection-check-run';
import { runBidAnalysisTask } from './bid-analysis';
import { runGlobalFactsGenerationTask } from './global-facts-generation';
import { runDuplicateAnalysisTask } from './duplicate-analysis';
import { runBidSectionExtractionTask } from './bid-section-extraction';
import { runOutlineGenerationTask } from './outline-generation';
import { runContentGenerationTask } from './content-generation';
import { runResponseDeviationGenerationTask } from './response-deviation-generation';

export function registerTaskRunners(taskService: TaskService): void {
  taskService.registerRunner('rejection-items-extraction', runRejectionItemsExtractionTask);
  taskService.registerRunner('rejection-check-run', runRejectionCheckTask);
  taskService.registerRunner('bid-analysis', runBidAnalysisTask);
  taskService.registerRunner('global-facts-generation', runGlobalFactsGenerationTask);
  taskService.registerRunner('duplicate-analysis', runDuplicateAnalysisTask);
  taskService.registerRunner('bid-section-extraction', runBidSectionExtractionTask);
  taskService.registerRunner('outline-generation', runOutlineGenerationTask);
  taskService.registerRunner('content-generation', runContentGenerationTask);
  taskService.registerRunner('response-deviation-generation', runResponseDeviationGenerationTask);
}
