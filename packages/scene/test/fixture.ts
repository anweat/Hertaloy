/**
 * 真跑出来的快照 —— 由 `packages/state/fixture-gen.mts` 生成。
 *
 * 手编夹具会不知不觉编成"我以为的形状"，而这个项目最熟悉的翻车方式
 * 恰恰是两端各自都绿、中间对不上。要更新就重跑那个脚本。
 */
export const FIXTURE: unknown = {
 "root": "job-1",
 "instances": {
  "job-1": {
   "traceid": "job-1",
   "templateRef": "root@1",
   "status": "OPEN",
   "nodes": {
    "plan": {
     "nodeId": "plan"
    },
    "merge": {
     "nodeId": "merge"
    },
    "watch": {
     "nodeId": "watch"
    },
    "idle": {
     "nodeId": "idle"
    }
   }
  },
  "job-1/a1": {
   "traceid": "job-1/a1",
   "templateRef": "worker@1",
   "status": "OPEN",
   "slot": "a",
   "nodes": {
    "scan": {
     "nodeId": "scan"
    },
    "wrap": {
     "nodeId": "wrap"
    }
   }
  },
  "job-1/b1": {
   "traceid": "job-1/b1",
   "templateRef": "worker@1",
   "status": "OPEN",
   "slot": "b",
   "nodes": {
    "scan": {
     "nodeId": "scan"
    },
    "wrap": {
     "nodeId": "wrap"
    }
   }
  }
 },
 "templates": {
  "root@1": {
   "nodes": {
    "plan": {
     "kind": "handler",
     "handler": "emit",
     "ports": {
      "start": {
       "direction": "receive",
       "servo": {
        "vars": {}
       }
      },
      "out": {
       "direction": "emit"
      }
     }
    },
    "merge": {
     "kind": "handler",
     "handler": "noop",
     "ports": {
      "got": {
       "direction": "receive",
       "servo": {
        "vars": {}
       }
      },
      "exit": {
       "direction": "receive",
       "servo": {
        "vars": {}
       }
      }
     }
    },
    "watch": {
     "kind": "handler",
     "handler": "noop",
     "ports": {
      "heard": {
       "direction": "receive",
       "servo": {
        "vars": {}
       }
      }
     }
    },
    "idle": {
     "kind": "handler",
     "handler": "noop",
     "ports": {
      "never": {
       "direction": "receive",
       "servo": {
        "vars": {}
       }
      }
     }
    }
   },
   "edges": {
    "p": {
     "from": {
      "node": "plan",
      "port": "out"
     },
     "to": {
      "node": "merge",
      "port": "got"
     }
    }
   },
   "children": {
    "a": {
     "template": "worker@1",
     "entry": {
      "node": "scan",
      "port": "in"
     },
     "exit": {
      "node": "merge",
      "port": "exit"
     }
    },
    "b": {
     "template": "worker@1",
     "entry": {
      "node": "scan",
      "port": "in"
     },
     "exit": {
      "node": "merge",
      "port": "exit"
     }
    }
   },
   "subscriptions": {
    "listen": {
     "tunnel": "findings",
     "to": {
      "node": "watch",
      "port": "heard"
     }
    },
    "quiet": {
     "tunnel": "silence",
     "to": {
      "node": "idle",
      "port": "never"
     }
    }
   }
  },
  "worker@1": {
   "nodes": {
    "scan": {
     "kind": "handler",
     "handler": "emit",
     "ports": {
      "in": {
       "direction": "receive",
       "servo": {
        "vars": {}
       }
      },
      "found": {
       "direction": "emit",
       "tunnel": "findings"
      },
      "out": {
       "direction": "emit"
      }
     }
    },
    "wrap": {
     "kind": "handler",
     "handler": "noop",
     "ports": {
      "got": {
       "direction": "receive",
       "servo": {
        "vars": {}
       }
      }
     }
    }
   },
   "edges": {
    "e": {
     "from": {
      "node": "scan",
      "port": "out"
     },
     "to": {
      "node": "wrap",
      "port": "got"
     }
    }
   },
   "children": {},
   "subscriptions": {}
  }
 },
 "messages": [
  {
   "id": "msg-1",
   "target": {
    "traceid": "job-1",
    "node": "plan",
    "port": "start"
   },
   "state": "CONSUMED"
  },
  {
   "id": "msg-2",
   "target": {
    "traceid": "job-1/a1",
    "node": "scan",
    "port": "in"
   },
   "state": "CONSUMED"
  },
  {
   "id": "msg-3",
   "target": {
    "traceid": "job-1/b1",
    "node": "scan",
    "port": "in"
   },
   "state": "CONSUMED"
  },
  {
   "id": "msg-4",
   "target": {
    "traceid": "job-1",
    "node": "merge",
    "port": "got"
   },
   "state": "CONSUMED",
   "source": {
    "traceid": "job-1",
    "node": "plan",
    "port": "out"
   }
  },
  {
   "id": "msg-5",
   "target": {
    "traceid": "job-1/a1",
    "node": "wrap",
    "port": "got"
   },
   "state": "CONSUMED",
   "source": {
    "traceid": "job-1/a1",
    "node": "scan",
    "port": "out"
   }
  },
  {
   "id": "msg-6",
   "target": {
    "traceid": "job-1",
    "node": "watch",
    "port": "heard"
   },
   "state": "CONSUMED",
   "source": {
    "traceid": "job-1/a1",
    "node": "scan",
    "port": "found"
   },
   "tunnel": "findings"
  },
  {
   "id": "msg-7",
   "target": {
    "traceid": "job-1/b1",
    "node": "wrap",
    "port": "got"
   },
   "state": "CONSUMED",
   "source": {
    "traceid": "job-1/b1",
    "node": "scan",
    "port": "out"
   }
  },
  {
   "id": "msg-8",
   "target": {
    "traceid": "job-1",
    "node": "watch",
    "port": "heard"
   },
   "state": "CONSUMED",
   "source": {
    "traceid": "job-1/b1",
    "node": "scan",
    "port": "found"
   },
   "tunnel": "findings"
  }
 ],
 "records": [],
 "objects": [
  {
   "object_id": "worker",
   "kind": "container_template",
   "version": 1
  },
  {
   "object_id": "root",
   "kind": "root_config",
   "version": 1
  },
  {
   "object_id": "job-1/note-plan",
   "kind": "artifact",
   "version": 1
  },
  {
   "object_id": "job-1/$run",
   "kind": "run",
   "version": 1
  },
  {
   "object_id": "job-1/a1/note-scan",
   "kind": "artifact",
   "version": 1
  },
  {
   "object_id": "job-1/a1/$run",
   "kind": "run",
   "version": 1
  },
  {
   "object_id": "job-1/b1/note-scan",
   "kind": "artifact",
   "version": 1
  },
  {
   "object_id": "job-1/b1/$run",
   "kind": "run",
   "version": 1
  },
  {
   "object_id": "job-1/$run",
   "kind": "run",
   "version": 2
  },
  {
   "object_id": "job-1/a1/$run",
   "kind": "run",
   "version": 2
  },
  {
   "object_id": "job-1/$run",
   "kind": "run",
   "version": 3
  },
  {
   "object_id": "job-1/b1/$run",
   "kind": "run",
   "version": 2
  },
  {
   "object_id": "job-1/$run",
   "kind": "run",
   "version": 4
  }
 ]
}
