/**
 * 真跑出来的快照 —— 由 `packages/state/fixture-gen.mts` 生成。
 *
 * 刻意造了落差：子槽 a 扇出三个实例且命运不同（a1/a2 收口、a3 还开着，
 * 于是根容器被 a3 的子容器锁挡着），子槽 b 一次都没 spawn。
 * 手编夹具会编成"我以为的形状"。要更新就重跑那个脚本。
 */
export const FIXTURE: unknown = {
 "root": "job-1",
 "instances": {
  "job-1": {
   "traceid": "job-1",
   "templateRef": "root@1",
   "status": "OPEN",
   "bindings": [
    {
     "alias": "findings",
     "container": "job-1",
     "node": "watch",
     "port": "heard",
     "inherit": true
    },
    {
     "alias": "silence",
     "container": "job-1",
     "node": "idle",
     "port": "never",
     "inherit": true
    }
   ]
  },
  "job-1/a1": {
   "traceid": "job-1/a1",
   "templateRef": "worker@1",
   "status": "TERMINAL",
   "slot": "a",
   "bindings": [
    {
     "alias": "findings",
     "container": "job-1",
     "node": "watch",
     "port": "heard",
     "inherit": true
    },
    {
     "alias": "silence",
     "container": "job-1",
     "node": "idle",
     "port": "never",
     "inherit": true
    }
   ]
  },
  "job-1/a2": {
   "traceid": "job-1/a2",
   "templateRef": "worker@1",
   "status": "TERMINAL",
   "slot": "a",
   "bindings": [
    {
     "alias": "findings",
     "container": "job-1",
     "node": "watch",
     "port": "heard",
     "inherit": true
    },
    {
     "alias": "silence",
     "container": "job-1",
     "node": "idle",
     "port": "never",
     "inherit": true
    }
   ]
  },
  "job-1/a3": {
   "traceid": "job-1/a3",
   "templateRef": "worker@1",
   "status": "OPEN",
   "slot": "a",
   "bindings": [
    {
     "alias": "findings",
     "container": "job-1",
     "node": "watch",
     "port": "heard",
     "inherit": true
    },
    {
     "alias": "silence",
     "container": "job-1",
     "node": "idle",
     "port": "never",
     "inherit": true
    }
   ]
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
    "review": {
     "kind": "handler",
     "agent": {
      "argv": [
       "claude"
      ]
     },
     "ports": {
      "task": {
       "direction": "receive",
       "servo": {
        "vars": {}
       }
      },
      "done": {
       "direction": "emit"
      }
     }
    },
    "audit": {
     "kind": "handler",
     "agent": {
      "argv": [
       "codex"
      ]
     },
     "ports": {
      "task": {
       "direction": "receive",
       "servo": {
        "vars": {}
       }
      },
      "done": {
       "direction": "emit"
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
   "bindings": [
    {
     "alias": "findings",
     "node": "watch",
     "port": "heard"
    },
    {
     "alias": "silence",
     "node": "idle",
     "port": "never"
    }
   ],
   "selfBindings": []
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
       "alias": "findings"
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
   "bindings": [],
   "selfBindings": []
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
   "id": "msg-4",
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
   "id": "msg-5",
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
   "alias": "findings"
  },
  {
   "id": "msg-6",
   "target": {
    "traceid": "job-1/a2",
    "node": "scan",
    "port": "in"
   },
   "state": "CONSUMED"
  },
  {
   "id": "msg-7",
   "target": {
    "traceid": "job-1/a2",
    "node": "wrap",
    "port": "got"
   },
   "state": "CONSUMED",
   "source": {
    "traceid": "job-1/a2",
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
    "traceid": "job-1/a2",
    "node": "scan",
    "port": "found"
   },
   "alias": "findings"
  },
  {
   "id": "msg-9",
   "target": {
    "traceid": "job-1/a3",
    "node": "scan",
    "port": "in"
   },
   "state": "CONSUMED"
  },
  {
   "id": "msg-10",
   "target": {
    "traceid": "job-1/a3",
    "node": "wrap",
    "port": "got"
   },
   "state": "CONSUMED",
   "source": {
    "traceid": "job-1/a3",
    "node": "scan",
    "port": "out"
   }
  },
  {
   "id": "msg-11",
   "target": {
    "traceid": "job-1",
    "node": "watch",
    "port": "heard"
   },
   "state": "CONSUMED",
   "source": {
    "traceid": "job-1/a3",
    "node": "scan",
    "port": "found"
   },
   "alias": "findings"
  },
  {
   "id": "msg-12",
   "target": {
    "traceid": "job-1",
    "node": "review",
    "port": "task"
   },
   "state": "CLAIMED"
  },
  {
   "id": "msg-13",
   "target": {
    "traceid": "job-1",
    "node": "audit",
    "port": "task"
   },
   "state": "QUEUED"
  },
  {
   "id": "msg-14",
   "target": {
    "traceid": "job-1/a3",
    "node": "scan",
    "port": "in"
   },
   "state": "QUEUED"
  },
  {
   "id": "msg-15",
   "target": {
    "traceid": "job-1",
    "node": "merge",
    "port": "exit"
   },
   "state": "QUEUED",
   "source": {
    "traceid": "job-1/a1"
   }
  },
  {
   "id": "msg-16",
   "target": {
    "traceid": "job-1",
    "node": "merge",
    "port": "exit"
   },
   "state": "QUEUED",
   "source": {
    "traceid": "job-1/a2"
   }
  }
 ],
 "records": [
  {
   "executionId": "exec-1",
   "traceid": "job-1",
   "nodeId": "review",
   "status": "RUNNING"
  },
  {
   "executionId": "exec-2",
   "traceid": "job-1",
   "nodeId": "audit",
   "status": "SETTLED",
   "termination": "FAILED"
  }
 ],
 "objects": [
  {
   "object_id": "job-1/note-plan",
   "kind": "artifact",
   "version": 1,
   "owner": "job-1"
  },
  {
   "object_id": "job-1/$run",
   "kind": "run",
   "version": 1,
   "owner": "job-1"
  },
  {
   "object_id": "job-1/a1/note-scan",
   "kind": "artifact",
   "version": 1,
   "owner": "job-1/a1"
  },
  {
   "object_id": "job-1/a1/$run",
   "kind": "run",
   "version": 1,
   "owner": "job-1/a1"
  },
  {
   "object_id": "job-1/$run",
   "kind": "run",
   "version": 2,
   "owner": "job-1"
  },
  {
   "object_id": "job-1/a1/$run",
   "kind": "run",
   "version": 2,
   "owner": "job-1/a1"
  },
  {
   "object_id": "job-1/$run",
   "kind": "run",
   "version": 3,
   "owner": "job-1"
  },
  {
   "object_id": "job-1/a2/note-scan",
   "kind": "artifact",
   "version": 1,
   "owner": "job-1/a2"
  },
  {
   "object_id": "job-1/a2/$run",
   "kind": "run",
   "version": 1,
   "owner": "job-1/a2"
  },
  {
   "object_id": "job-1/a2/$run",
   "kind": "run",
   "version": 2,
   "owner": "job-1/a2"
  },
  {
   "object_id": "job-1/$run",
   "kind": "run",
   "version": 4,
   "owner": "job-1"
  },
  {
   "object_id": "job-1/a3/note-scan",
   "kind": "artifact",
   "version": 1,
   "owner": "job-1/a3"
  },
  {
   "object_id": "job-1/a3/$run",
   "kind": "run",
   "version": 1,
   "owner": "job-1/a3"
  },
  {
   "object_id": "job-1/a3/$run",
   "kind": "run",
   "version": 2,
   "owner": "job-1/a3"
  },
  {
   "object_id": "job-1/$run",
   "kind": "run",
   "version": 5,
   "owner": "job-1"
  },
  {
   "object_id": "job-1/$exec",
   "kind": "execution",
   "version": 1,
   "owner": "job-1"
  }
 ],
 "obligations": [
  {
   "holder": "job-1",
   "kind": "message",
   "key": "msg-12",
   "originNode": "review"
  },
  {
   "holder": "job-1",
   "kind": "message",
   "key": "msg-13",
   "originNode": "audit"
  },
  {
   "holder": "job-1/a3",
   "kind": "message",
   "key": "msg-14",
   "originNode": "scan"
  },
  {
   "holder": "job-1",
   "kind": "message",
   "key": "msg-15",
   "originNode": "merge"
  },
  {
   "holder": "job-1",
   "kind": "message",
   "key": "msg-16",
   "originNode": "merge"
  },
  {
   "holder": "job-1",
   "kind": "execution",
   "key": "exec-1",
   "originNode": "review"
  },
  {
   "holder": "job-1",
   "kind": "child",
   "key": "job-1/a3",
   "waitingOn": "job-1/a3"
  }
 ],
 "commits": [
  {
   "traceid": "job-1",
   "node": "plan",
   "consumed": [
    "msg-1"
   ]
  },
  {
   "traceid": "job-1",
   "node": "merge",
   "consumed": [
    "msg-3"
   ]
  },
  {
   "traceid": "job-1",
   "node": "watch",
   "consumed": [
    "msg-11"
   ]
  },
  {
   "traceid": "job-1/a1",
   "node": "scan",
   "consumed": [
    "msg-2"
   ]
  },
  {
   "traceid": "job-1/a1",
   "node": "wrap",
   "consumed": [
    "msg-4"
   ]
  },
  {
   "traceid": "job-1/a2",
   "node": "scan",
   "consumed": [
    "msg-6"
   ]
  },
  {
   "traceid": "job-1/a2",
   "node": "wrap",
   "consumed": [
    "msg-7"
   ]
  },
  {
   "traceid": "job-1/a3",
   "node": "scan",
   "consumed": [
    "msg-9"
   ]
  },
  {
   "traceid": "job-1/a3",
   "node": "wrap",
   "consumed": [
    "msg-10"
   ]
  }
 ]
};
